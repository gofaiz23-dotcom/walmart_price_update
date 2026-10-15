import { parseMoney } from '../validation/prices.js';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      continue;
    }
    if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((cell) => cell !== '')) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((cell) => cell.trim());
  return rows.slice(1).map((cells) => {
    const out = {};
    headers.forEach((header, index) => {
      if (!header) return;
      out[header] = (cells[index] ?? '').trim();
    });
    return out;
  });
}

function rowGet(row, names) {
  const lowered = new Map();
  for (const [key, value] of Object.entries(row)) {
    lowered.set(key.trim().toLowerCase(), value);
  }
  for (const name of names) {
    const value = lowered.get(name.toLowerCase());
    if (value != null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

export function parseQty(value) {
  if (value == null || value === '') return null;
  const cleaned = String(value).trim().replace(/,/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function qtyAmount(value) {
  if (value == null) return null;
  if (typeof value === 'number' || typeof value === 'string') return parseQty(value);
  if (typeof value === 'object') return parseQty(value.amount ?? value.Amount);
  return null;
}

function sumInventoryNodes(sku, productName, nodes) {
  let available = 0;
  let input = 0;
  let hasAvailable = false;
  let hasInput = false;
  for (const node of nodes) {
    if (node.available != null) {
      available += node.available;
      hasAvailable = true;
    }
    if (node.input != null) {
      input += node.input;
      hasInput = true;
    }
  }
  return {
    sku,
    productName: String(productName || '').trim(),
    available: hasAvailable ? available : null,
    input: hasInput ? input : null,
    nodes,
  };
}

/** Map an INVENTORY report CSV to one row per SKU, summing every ship node. */
export function inventoryRowsFromReportCsv(csvRows) {
  const bySku = new Map();
  for (const row of csvRows) {
    const sku = rowGet(row, ['SKU', 'sku', 'Seller SKU']);
    if (!sku) continue;
    const key = sku.toLowerCase();
    let agg = bySku.get(key);
    if (!agg) {
      agg = { sku, productName: '', nodes: [] };
      bySku.set(key, agg);
    }
    const productName = rowGet(row, ['Product Name', 'productName', 'itemName']);
    if (productName) agg.productName = productName;
    agg.nodes.push({
      shipNode: rowGet(row, ['Ship Node ID', 'Ship Node', 'shipNode']),
      shipNodeName: rowGet(row, ['Ship Node Name', 'shipNodeName']),
      available: parseQty(rowGet(row, [
        'AvailToSell Quantity',
        'AvailToSell Qty',
        'Available to Sell Quantity',
        'Available Quantity',
      ])),
      input: parseQty(rowGet(row, ['Input Quantity', 'Input Qty', 'inputQty'])),
    });
  }
  return [...bySku.values()].map((agg) => sumInventoryNodes(agg.sku, agg.productName, agg.nodes));
}

/** One inventories API object, across every ship node on that SKU. */
export function inventoryRecordFromItem(item) {
  if (!item || typeof item !== 'object') return null;
  const sku = String(item.sku || item.SKU || '').trim();
  if (!sku) return null;
  const rawNodes = item.nodes || item.shipNodes;
  const nodes = [];
  if (Array.isArray(rawNodes) && rawNodes.length) {
    for (const node of rawNodes) {
      if (!node || typeof node !== 'object') continue;
      nodes.push({
        shipNode: String(node.shipNode || node.shipNodeId || '').trim(),
        shipNodeName: String(node.shipNodeName || '').trim(),
        available: qtyAmount(node.availToSellQty ?? node.availToSellQuantity),
        input: qtyAmount(node.inputQty ?? node.inputQuantity),
      });
    }
  } else {
    nodes.push({
      shipNode: String(item.shipNode || '').trim(),
      shipNodeName: String(item.shipNodeName || '').trim(),
      available: qtyAmount(item.availToSellQty ?? item.availToSellQuantity),
      input: qtyAmount(item.inputQty ?? item.inputQuantity),
    });
  }
  return sumInventoryNodes(sku, item.productName || item.product_name || '', nodes);
}

/** Map an ITEM report CSV row to { sku, price, currency }. */
export function itemRowsFromReportCsv(csvRows) {
  const out = [];
  for (const row of csvRows) {
    const sku = rowGet(row, ['SKU', 'sku', 'Seller SKU']);
    if (!sku) continue;
    const price = parseMoney(rowGet(row, ['Price', 'price', 'Buy Box Item Price', 'Buy Box Price']));
    const currency = rowGet(row, ['Currency', 'currency', 'currencyCode']) || 'USD';
    const productName = rowGet(row, ['Product Name', 'productName', 'itemName']);
    out.push({ sku, price, currency, productName });
  }
  return out;
}

export function extractInventoryItems(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const elements = payload.elements || payload.Elements || payload.payload?.elements || payload.data?.elements;
  const candidates = [
    elements?.inventories,
    elements?.inventory,
    payload.inventories,
    payload.inventory,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter((row) => row && typeof row === 'object');
    if (candidate && typeof candidate === 'object') return [candidate];
  }
  return [];
}

/**
 * Walmart inventory cursors are passed back exactly as issued.
 * Encoding them again (URLSearchParams turns "%" into "%25") makes the next page fail.
 */
export function inventoriesPagePath(cursor, limit) {
  const size = String(Math.min(50, Math.max(1, Number(limit) || 50)));
  const base = `/v3/inventories?limit=${encodeURIComponent(size)}`;
  const raw = String(cursor ?? '');
  if (!raw.trim()) return base;
  return `${base}&nextCursor=${raw}`;
}

export function extractItemRows(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [payload.ItemResponse, payload.itemResponse, payload.items, payload.Item];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter((row) => row && typeof row === 'object');
    if (candidate && typeof candidate === 'object') return [candidate];
  }
  return [];
}

export function extractPriceAmount(item) {
  if (!item || typeof item !== 'object') return null;
  const price = item.price ?? item.Price;
  if (price == null) return null;
  if (typeof price === 'number' || typeof price === 'string') return parseMoney(price);
  if (typeof price === 'object') {
    return parseMoney(price.amount ?? price.Amount ?? price.value);
  }
  return null;
}

export function extractProductName(item) {
  if (!item || typeof item !== 'object') return '';
  return String(item.productName || item.product_name || item.itemName || item.shelf || '').trim();
}

export function extractCurrency(item) {
  const price = item?.price ?? item?.Price;
  if (price && typeof price === 'object') {
    return String(price.currency || price.Currency || 'USD');
  }
  return 'USD';
}

/**
 * Walmart often returns nextCursor as a ready-made query (`?limit=1000&offset=1000`),
 * not as a token to nest inside another nextCursor parameter.
 */
export function itemsPagePath(cursor, limit) {
  const size = String(Math.min(1000, Math.max(1, Number(limit) || 1000)));
  let raw = String(cursor || '').trim();
  if (!raw || raw === '*') {
    return `/v3/items?${new URLSearchParams({ limit: size, nextCursor: '*' })}`;
  }
  try {
    if (raw.includes('%')) raw = decodeURIComponent(raw);
  } catch {
    /* keep the cursor Walmart sent */
  }
  if (raw.startsWith('?')) raw = raw.slice(1);
  if (/(^|&)(offset|limit|nextCursor)=/i.test(raw)) {
    const params = new URLSearchParams(raw);
    if (!params.get('limit')) params.set('limit', size);
    return `/v3/items?${params.toString()}`;
  }
  return `/v3/items?${new URLSearchParams({ limit: size, nextCursor: raw })}`;
}

export function nextCursorFrom(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const meta = payload.meta || payload.Meta || payload.data?.meta || payload.data?.Meta;
  const raw =
    meta?.nextCursor ||
    meta?.next_cursor ||
    payload.nextCursor ||
    payload.next_cursor ||
    payload.data?.nextCursor ||
    '';
  const cursor = String(raw || '').trim();
  if (!cursor || cursor === '*') return '';
  return cursor;
}

export function extractRequestId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  for (const key of ['requestId', 'requestID', 'id']) {
    if (payload[key] != null && String(payload[key]).trim()) return String(payload[key]).trim();
  }
  for (const nest of ['payload', 'report', 'data', 'result']) {
    const found = extractRequestId(payload[nest]);
    if (found) return found;
  }
  return '';
}

export function extractRequestStatus(payload) {
  if (!payload || typeof payload !== 'object') return '';
  for (const key of ['requestStatus', 'status', 'reportStatus']) {
    if (payload[key] != null && String(payload[key]).trim()) return String(payload[key]).trim().toUpperCase();
  }
  return '';
}

export function extractDownloadUrl(payload) {
  if (!payload || typeof payload !== 'object') return '';
  for (const key of [
    'downloadUrl',
    'downloadURL',
    'downloadLink',
    'download_url',
    'reportDownloadUrl',
    'reportDownloadURL',
  ]) {
    const value = payload[key];
    if (value != null && /^https?:\/\//i.test(String(value).trim())) return String(value).trim();
  }
  for (const nest of ['payload', 'report', 'data', 'result']) {
    const found = extractDownloadUrl(payload[nest]);
    if (found) return found;
  }
  return '';
}

export function requestsFromList(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const raw = payload.requests || payload.reportRequests || payload.data?.requests;
  if (!Array.isArray(raw)) return [];
  return raw.filter((row) => row && typeof row === 'object');
}

export const READY_STATUSES = new Set(['READY', 'DONE', 'COMPLETED']);
export const FAILED_STATUSES = new Set(['ERROR', 'FAILED', 'CANCELLED', 'CANCELED']);
