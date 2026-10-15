import {
  extractInventoryItems,
  extractRequestId,
  extractRequestStatus,
  inventoriesPagePath,
  inventoryRecordFromItem,
  inventoryRowsFromReportCsv,
  requestsFromList,
} from './parse.js';
import { csvRowsFromReportBuffer } from './priceApi.js';

function exactInventoryCursor(body) {
  const meta = body?.meta || body?.Meta || body?.data?.meta || body?.data?.Meta || null;
  const raw = meta?.nextCursor ?? meta?.next_cursor ?? body?.nextCursor ?? body?.next_cursor;
  if (raw == null) return '';
  const cursor = String(raw);
  return cursor.trim() ? cursor : '';
}

function inventoryErrorText(error) {
  return String(error?.message || error || '').toLowerCase();
}

export function isInventoryCursorError(error) {
  const msg = inventoryErrorText(error);
  return msg.includes('nextcursor') || msg.includes('pagination lock') || msg.includes('invalid_request_param.gmp_inventory_api');
}

export function isInventoryPaginationLockError(error) {
  return inventoryErrorText(error).includes('pagination lock');
}

export function createInventoryApi(client, { downloadReadyReport } = {}) {
  async function createInventoryReport() {
    const result = await client.request({
      method: 'POST',
      path: '/v3/reports/reportRequests?reportType=INVENTORY&reportVersion=v1',
      json: { reportType: 'INVENTORY', reportVersion: 'v1' },
      prefix: 'walmart-inventory-report-create',
    });
    const requestId = extractRequestId(result.body);
    if (!requestId) throw new Error('Walmart did not return an inventory report request id.');
    return { requestId, status: extractRequestStatus(result.body) || 'RECEIVED' };
  }

  async function listInventoryReports() {
    const result = await client.request({
      method: 'GET',
      path: '/v3/reports/reportRequests?reportType=INVENTORY&reportVersion=v1&limit=50',
      prefix: 'walmart-inventory-report-list',
    });
    return requestsFromList(result.body);
  }

  async function parseReportBuffer(buffer) {
    return inventoryRowsFromReportCsv(await csvRowsFromReportBuffer(buffer));
  }

  async function fetchAllInventoryPages(onProgress, {
    pageSize = 50,
    delayMs = 500,
    maxPages = 10000,
    maxRestarts = 5,
    staleWaitMs = 15_000,
    lockWaitMs = 30_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    const size = Math.min(50, Math.max(1, Number(pageSize) || 50));
    const gap = Math.max(0, Number(delayMs) || 0);
    const pageCap = Math.max(1, Number(maxPages) || 10000);
    const restarts = Math.max(0, Number(maxRestarts) || 0);

    for (let attempt = 0; attempt <= restarts; attempt += 1) {
      const rows = [];
      let cursor = '';
      const seenPageStarts = new Set();
      try {
        if (attempt > 0) {
          await onProgress?.({
            phase: 'inventories',
            restart: true,
            message: `Starting the inventory catalog again from the first page (attempt ${attempt + 1}).`,
            processed: 0,
            total: null,
            pageRows: [],
          });
        }
        for (let page = 1; page <= pageCap; page += 1) {
          const result = await client.request({
            method: 'GET',
            path: inventoriesPagePath(cursor, size),
            prefix: 'walmart-inventories',
            maxAttempts: 1,
          });
          const pageRows = extractInventoryItems(result.body)
            .map((item) => inventoryRecordFromItem(item))
            .filter(Boolean);
          if (!pageRows.length) {
            if (page === 1) {
              const keys = result.body && typeof result.body === 'object' ? Object.keys(result.body).join(', ') : '';
              throw new Error(`Walmart inventory page had no SKUs.${keys ? ` Response keys: ${keys}.` : ''}`);
            }
            break;
          }
          const startSku = pageRows[0]?.sku || '';
          if (startSku && seenPageStarts.has(startSku)) break;
          seenPageStarts.add(startSku);
          rows.push(...pageRows);
          const totalHint = Number(result.body?.meta?.totalCount ?? result.body?.totalCount);
          const total = Number.isFinite(totalHint) && totalHint > 0 ? totalHint : null;
          const next = exactInventoryCursor(result.body);
          const reachedTotal = total != null && rows.length >= total;
          const done = reachedTotal || !next || (total == null && pageRows.length < size);
          let message = done
            ? `Fetched inventory for ${rows.length} of ${total || rows.length} products.`
            : `Fetched inventory for ${rows.length} of ${total || '?'} products (page ${page}).`;
          if (!reachedTotal && total != null && rows.length < total && !next) {
            message = `Stopped at ${rows.length} of ${total}. Walmart did not return another page token.`;
          }
          await onProgress?.({ phase: 'inventories', message, processed: rows.length, total, pageRows });
          if (done) break;
          cursor = next;
          if (gap) await sleep(gap);
        }
        return rows;
      } catch (err) {
        if (!isInventoryCursorError(err) || attempt === restarts) throw err;
        const locked = isInventoryPaginationLockError(err);
        const wait = locked ? Math.max(lockWaitMs, staleWaitMs) : staleWaitMs;
        const why = locked ? 'Walmart inventory pagination is locked' : 'Walmart rejected the inventory page token';
        console.log(`[inventory] ${why}. Starting again from the first page after ${wait}ms.`);
        await onProgress?.({
          phase: 'inventories',
          restart: true,
          message: `${why}. Starting again from the first page.`,
          processed: 0,
          total: null,
          pageRows: [],
        });
        if (wait > 0) await sleep(wait);
      }
    }
    return [];
  }

  return {
    createInventoryReport,
    listInventoryReports,
    downloadReadyReport,
    parseReportBuffer,
    fetchAllInventoryPages,
  };
}
