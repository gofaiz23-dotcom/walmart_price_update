import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from '../config.js';
import {
  FAILED_STATUSES,
  READY_STATUSES,
  extractDownloadUrl,
  extractItemRows,
  extractPriceAmount,
  extractCurrency,
  extractProductName,
  extractRequestId,
  extractRequestStatus,
  itemRowsFromReportCsv,
  itemsPagePath,
  nextCursorFrom,
  parseCsv,
  requestsFromList,
} from './parse.js';
import { WalmartHttpError } from './http.js';
import { PRICE_FEED_HARD_CAP, PRICE_FEED_PATH, priceFeedBody } from './priceFeed.js';
import { feedStatusPath, feedsFromList } from './feedStatus.js';

async function unzipCsv(buffer) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir && !name.startsWith('__MACOSX'));
  const csvName = names.find((name) => name.toLowerCase().endsWith('.csv')) || names[0];
  if (!csvName) throw new Error('Walmart report ZIP contained no files.');
  return zip.files[csvName].async('nodebuffer');
}

export async function csvRowsFromReportBuffer(buffer) {
  let csvBuffer = buffer;
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    csvBuffer = await unzipCsv(buffer);
  }
  return parseCsv(csvBuffer.toString('utf8'));
}

export async function parseReportBuffer(buffer) {
  return itemRowsFromReportCsv(await csvRowsFromReportBuffer(buffer));
}

export function createPriceApi(client) {
  async function createItemReport() {
    const result = await client.request({
      method: 'POST',
      path: '/v3/reports/reportRequests?reportType=ITEM&reportVersion=v1',
      json: { format: 'CSV' },
      prefix: 'walmart-report-create',
    });
    const requestId = extractRequestId(result.body);
    if (!requestId) {
      throw new Error('Walmart did not return a report request id.');
    }
    return { requestId, status: extractRequestStatus(result.body) || 'RECEIVED' };
  }

  async function listItemReports() {
    const result = await client.request({
      method: 'GET',
      path: '/v3/reports/reportRequests?reportType=ITEM&reportVersion=v1&limit=50',
      prefix: 'walmart-report-list',
    });
    return requestsFromList(result.body);
  }

  async function getReportStatus(requestId) {
    const result = await client.request({
      method: 'GET',
      path: `/v3/reports/reportRequests/${encodeURIComponent(requestId)}`,
      prefix: 'walmart-report-status',
    });
    return result.body || {};
  }

  async function downloadReadyReport(requestId) {
    const statusBody = await getReportStatus(requestId);
    const status = extractRequestStatus(statusBody);
    if (FAILED_STATUSES.has(status)) {
      throw new Error(`Walmart report ${requestId} failed (${status}).`);
    }
    let downloadUrl = extractDownloadUrl(statusBody);
    if (!downloadUrl) {
      const listed = await client.request({
        method: 'GET',
        path: `/v3/reports/downloadReport?requestId=${encodeURIComponent(requestId)}`,
        prefix: 'walmart-report-download',
      });
      downloadUrl = extractDownloadUrl(listed.body);
      if (!downloadUrl && listed.buffer?.length > 20 && !String(listed.contentType).includes('json')) {
        return listed.buffer;
      }
    }
    if (!downloadUrl) {
      throw new WalmartHttpError('Walmart report is not ready to download yet.', { status: 409, retryable: true });
    }
    const file = await client.request({
      method: 'GET',
      url: downloadUrl,
      auth: false,
      raw: true,
      prefix: 'walmart-report-file',
      headers: { Accept: '*/*' },
    });
    const reportsDir = path.join(dataDir(), 'reports');
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.writeFile(path.join(reportsDir, `${requestId}.bin`), file.buffer);
    return file.buffer;
  }

  async function fetchAllItemPages(onProgress, { pageSize = 1000, delayMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const rows = [];
    let cursor = '*';
    const seenPageStarts = new Set();
    const size = Math.min(1000, Math.max(1, Number(pageSize) || 1000));
    const gap = Math.max(0, Number(delayMs) || 0);
    for (let page = 1; page <= 5000; page += 1) {
      const result = await client.request({
        method: 'GET',
        path: itemsPagePath(cursor, size),
        prefix: 'walmart-items',
        maxAttempts: 8,
      });
      const items = extractItemRows(result.body);
      const pageRows = [];
      for (const item of items) {
        const sku = String(item.sku || item.SKU || '').trim();
        if (!sku) continue;
        pageRows.push({
          sku,
          price: extractPriceAmount(item),
          currency: extractCurrency(item),
          productName: extractProductName(item),
        });
      }
      const startSku = pageRows[0]?.sku || '';
      if (!pageRows.length || (startSku && seenPageStarts.has(startSku))) {
        const totalHint = Number(result.body?.totalItems) || rows.length;
        if (rows.length && startSku && seenPageStarts.has(startSku)) {
          await onProgress?.({
            phase: 'items',
            message: `Stopped at ${rows.length} of ${totalHint}. Walmart repeated a page that was already saved.`,
            processed: rows.length,
            total: totalHint,
            pageRows: [],
          });
        }
        break;
      }
      seenPageStarts.add(startSku);
      rows.push(...pageRows);
      const totalHint = Number(result.body?.totalItems);
      const total = Number.isFinite(totalHint) && totalHint > 0 ? totalHint : null;
      const next = nextCursorFrom(result.body);
      const reachedTotal = total != null && rows.length >= total;
      const done = reachedTotal || !next || (total == null && pageRows.length < size);
      let message = done
        ? `Fetched ${rows.length} of ${total || rows.length} products.`
        : (gap
          ? `Fetched ${rows.length} of ${total || '?'} products (page ${page}). Waiting ${Math.round(gap / 1000)}s before the next page.`
          : `Fetched ${rows.length} of ${total || '?'} products (page ${page}).`);
      if (!reachedTotal && total != null && rows.length < total && !next) {
        message = `Stopped at ${rows.length} of ${total}. Walmart did not return another page token.`;
      }
      await onProgress?.({ phase: 'items', message, processed: rows.length, total, pageRows });
      if (done) break;
      cursor = next;
      if (gap) await sleep(gap);
    }
    return rows;
  }

  async function getItemPrice(sku) {
    const result = await client.request({
      method: 'GET',
      path: `/v3/items/${encodeURIComponent(sku)}`,
      prefix: 'walmart-item-sku',
    });
    const items = extractItemRows(result.body);
    const item = items[0];
    if (!item) return { sku, price: null, currency: 'USD' };
    return {
      sku: String(item.sku || sku).trim() || sku,
      price: extractPriceAmount(item),
      currency: extractCurrency(item),
    };
  }

  async function submitPriceFeed(items) {
    const rows = (items || [])
      .map((item) => ({ sku: String(item?.sku || '').trim(), price: Number(item?.price) }))
      .filter((item) => item.sku && Number.isFinite(item.price));
    if (!rows.length) {
      throw new WalmartHttpError('A price feed needs at least one product.', { status: 400, retryable: false });
    }
    if (rows.length > PRICE_FEED_HARD_CAP) {
      throw new WalmartHttpError(`A price feed can hold at most ${PRICE_FEED_HARD_CAP} products.`, { status: 400, retryable: false });
    }
    const result = await client.request({
      method: 'POST',
      path: PRICE_FEED_PATH,
      prefix: 'walmart-price-feed',
      json: priceFeedBody(rows),
    });
    const errorText = bodyError(result.body);
    if (errorText) {
      throw new WalmartHttpError(errorText, { status: result.status, retryable: false });
    }
    const feedId = String(result.body?.feedId || result.body?.feedID || '').trim();
    if (!feedId) {
      throw new WalmartHttpError('Walmart did not return a price feed id.', { status: result.status, retryable: false });
    }
    return { feedId, itemCount: rows.length };
  }

  async function putPrice(sku, amount) {
    return submitPriceFeed([{ sku, price: amount }]);
  }

  async function listPriceFeeds() {
    const result = await client.request({
      method: 'GET',
      path: '/v3/feeds?feedType=PRICE_AND_PROMOTION&limit=20',
      prefix: 'walmart-price-feed-list',
    });
    return feedsFromList(result.body);
  }

  async function getPriceFeedStatus(feedId) {
    const id = String(feedId || '').trim();
    if (!id) throw new WalmartHttpError('A feed id is required.', { status: 400, retryable: false });
    let offset = 0;
    let summary = {};
    const items = [];
    for (let page = 0; page < 40; page += 1) {
      const result = await client.request({
        method: 'GET',
        path: feedStatusPath(id, { offset, limit: 1000 }),
        prefix: 'walmart-price-feed-status',
      });
      const body = result.body || {};
      summary = { ...body, itemDetails: undefined };
      const pageItems = body?.itemDetails?.itemIngestionStatus || [];
      const rows = Array.isArray(pageItems) ? pageItems : pageItems ? [pageItems] : [];
      items.push(...rows);
      const received = Number(body.itemsReceived || 0);
      if (!rows.length) break;
      if (received > 0 && items.length >= received) break;
      if (!received && rows.length < 1000) break;
      offset += rows.length;
    }
    return { ...summary, itemDetails: { itemIngestionStatus: items } };
  }

  return {
    createItemReport,
    listItemReports,
    getReportStatus,
    downloadReadyReport,
    parseReportBuffer,
    fetchAllItemPages,
    getItemPrice,
    submitPriceFeed,
    putPrice,
    listPriceFeeds,
    getPriceFeedStatus,
  };
}

function bodyError(body) {
  if (!body || typeof body !== 'object') return '';
  if (typeof body.error === 'string') return body.error;
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors
      .map((item) => item?.description || item?.info || item?.message || item?.code)
      .filter(Boolean)
      .join('; ');
  }
  if (Array.isArray(body.error) && body.error.length) {
    return body.error.map((item) => item?.description || item?.info || item?.message).filter(Boolean).join('; ');
  }
  return '';
}

export { READY_STATUSES, FAILED_STATUSES };
