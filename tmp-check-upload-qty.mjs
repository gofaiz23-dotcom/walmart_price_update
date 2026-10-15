import fs from 'node:fs';
import { createWalmartClient } from './src/walmart/http.js';

const files = [
  ['Poundex', 'C:/Users/Hi/Downloads/Walmart_Poundex_2026-10-14_21-50-25.csv'],
  ['Furniture of America', 'C:/Users/Hi/Downloads/Walmart_Furniture-of-America_2026-10-14_21-37-39.csv'],
  ['Homelegance', 'C:/Users/Hi/Downloads/Walmart_Homelegance_2026-10-14_21-32-29.csv'],
  ['Crown Mark', 'C:/Users/Hi/Downloads/Walmart_Crown-Mark_2026-10-14_21-12-01.csv'],
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

const items = [];
for (const [brandFile, file] of files) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const r of rows.slice(1)) {
    const sku = (r[idx.SKU] || '').trim();
    if (!sku) continue;
    const upload = Number(String(r[idx['Upload qty']] ?? '').trim());
    items.push({
      brand: r[idx.Brand] || brandFile,
      sku,
      upload: Number.isFinite(upload) ? upload : null,
      mpQty: r[idx['MP qty']] ?? '',
    });
  }
}

const client = createWalmartClient();
const outPath = 'tmp-upload-qty-check.json';
const results = [];
let cursor = 0;
const concurrency = 4;

async function one(item) {
  const path = `/v3/inventories/${encodeURIComponent(item.sku)}`;
  const result = await client.request({
    method: 'GET',
    path,
    prefix: 'walmart-inventory-check',
    maxAttempts: 4,
  });
  const nodes = Array.isArray(result.body?.nodes) ? result.body.nodes : [];
  let input = 0;
  let available = 0;
  let reserved = 0;
  let hasInput = false;
  for (const node of nodes) {
    const inputAmt = node?.inputQty?.amount;
    const availAmt = node?.availToSellQty?.amount;
    const reservedAmt = node?.reservedQty?.amount;
    if (inputAmt != null && inputAmt !== '') {
      input += Number(inputAmt);
      hasInput = true;
    }
    if (availAmt != null && availAmt !== '') available += Number(availAmt);
    if (reservedAmt != null && reservedAmt !== '') reserved += Number(reservedAmt);
  }
  const walmartInput = hasInput ? input : null;
  const match = item.upload != null && walmartInput != null && Number(item.upload) === Number(walmartInput);
  return {
    ...item,
    walmartInput,
    walmartAvailable: nodes.length ? available : null,
    walmartReserved: nodes.length ? reserved : null,
    nodes: nodes.length,
    match,
    status: !nodes.length ? 'missing' : match ? 'updated' : 'not-updated',
  };
}

async function worker() {
  while (cursor < items.length) {
    const index = cursor;
    cursor += 1;
    const item = items[index];
    try {
      results[index] = await one(item);
    } catch (err) {
      results[index] = {
        ...item,
        walmartInput: null,
        walmartAvailable: null,
        status: 'error',
        error: String(err.message || err).slice(0, 240),
      };
    }
    if ((index + 1) % 100 === 0 || index + 1 === items.length) {
      const done = results.filter(Boolean);
      const updated = done.filter((r) => r.status === 'updated').length;
      const notUpdated = done.filter((r) => r.status === 'not-updated').length;
      const missing = done.filter((r) => r.status === 'missing').length;
      const errors = done.filter((r) => r.status === 'error').length;
      console.log(`checked ${done.length}/${items.length} updated=${updated} notUpdated=${notUpdated} missing=${missing} errors=${errors}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
fs.writeFileSync(outPath, JSON.stringify(results, null, 0));

const byBrand = {};
for (const row of results) {
  const brand = row.brand || 'unknown';
  if (!byBrand[brand]) byBrand[brand] = { updated: 0, notUpdated: 0, missing: 0, error: 0, total: 0 };
  byBrand[brand].total += 1;
  if (row.status === 'updated') byBrand[brand].updated += 1;
  else if (row.status === 'not-updated') byBrand[brand].notUpdated += 1;
  else if (row.status === 'missing') byBrand[brand].missing += 1;
  else byBrand[brand].error += 1;
}
console.log('BY_BRAND', JSON.stringify(byBrand));
const mismatches = results.filter((r) => r.status === 'not-updated').slice(0, 25);
console.log('MISMATCH_SAMPLE', JSON.stringify(mismatches.map((r) => ({
  brand: r.brand,
  sku: r.sku,
  upload: r.upload,
  walmartInput: r.walmartInput,
  walmartAvailable: r.walmartAvailable,
}))));
const errors = results.filter((r) => r.status === 'error').slice(0, 5);
console.log('ERROR_SAMPLE', JSON.stringify(errors.map((r) => ({ sku: r.sku, error: r.error }))));
