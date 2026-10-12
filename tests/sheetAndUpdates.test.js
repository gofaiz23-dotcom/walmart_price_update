import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSheetStore } from '../src/store/sheetStore.js';
import { toCsv } from '../src/store/exportSheet.js';
import { runFetchPrices } from '../src/services/fetchPrices.js';
import { runPriceUpdates } from '../src/services/updatePrices.js';

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-sheet-'));
  return createSheetStore(path.join(dir, 'walmart-price-sheet.json'));
}

function jobs() {
  return {
    async update(job, patch) {
      Object.assign(job, patch);
    },
    async log() {},
    async readCheckpoint() {
      return null;
    },
    async writeCheckpoint() {},
    async clearCheckpoint() {},
  };
}

test('a percent reduction changes only the selected series', async () => {
  const store = await tempStore();
  await store.applyFetch(
    [
      { sku: 'MR-1-01FA', price: 20, currency: 'USD' },
      { sku: 'MR-2-04HE', price: 10, currency: 'USD' },
      { sku: 'IS-1-GBA-1', price: 8, currency: 'USD' },
    ],
    { fetchedAt: '2026-10-12T00:00:00.000Z', jobId: 'a' },
  );
  const result = await store.adjustByPercent({ prefix: 'mr', mrCategory: '01FA' }, 50);
  assert.equal(result.updated, 1);
  const rows = await store.list();
  assert.equal(rows.find((row) => row.sku === 'MR-1-01FA').proposedPrice, 10);
  assert.equal(rows.find((row) => row.sku === 'MR-1-01FA').updateStatus, 'Pending');
  assert.equal(rows.find((row) => row.sku === 'MR-2-04HE').proposedPrice, null);
  assert.equal(rows.find((row) => row.sku === 'IS-1-GBA-1').proposedPrice, null);
});

test('re-fetch updates the same SKU and does not duplicate case variants', async () => {
  const store = await tempStore();
  await store.applyFetch(
    [
      { sku: 'MR-123-01FA', price: 10, currency: 'USD' },
      { sku: 'IS-1-GBA-1', price: 20, currency: 'USD' },
    ],
    { fetchedAt: '2026-10-09T00:00:00.000Z', jobId: 'a' },
  );
  await store.applyFetch(
    [
      { sku: 'mr-123-01fa', price: 12, currency: 'USD' },
      { sku: 'IS-1-GBA-1', price: null, currency: 'USD' },
    ],
    { fetchedAt: '2026-10-09T01:00:00.000Z', jobId: 'b' },
  );
  const records = await store.list();
  assert.equal(records.length, 2);
  const mr = records.find((row) => row.sku === 'MR-123-01FA');
  assert.equal(mr.walmartCurrentPrice, 12);
  assert.equal(mr.lastFetchedAt, '2026-10-09T01:00:00.000Z');
  const isRow = records.find((row) => row.sku === 'IS-1-GBA-1');
  assert.equal(isRow.walmartCurrentPrice, 20);
});

test('a failed update does not replace the confirmed Walmart price', async () => {
  const store = await tempStore();
  await store.applyFetch([{ sku: 'MR-123-04HE', price: 40, currency: 'USD' }], {
    fetchedAt: '2026-10-09T00:00:00.000Z',
    jobId: 'fetch',
  });
  await store.setProposed('MR-123-04HE', 55);
  const job = { id: 'job_fail', failures: [] };
  await runPriceUpdates({
    store,
    jobManager: jobs(),
    job,
    scope: 'selected',
    skus: ['MR-123-04HE'],
    filter: {},
    putDelayMs: 0,
    verify: true,
    sleep: async () => {},
    api: {
      async putPrice() {
        throw new Error('Walmart PUT price failed (400)');
      },
      async getItemPrice() {
        throw new Error('should not verify a rejected update');
      },
    },
  });
  const [row] = await store.list();
  assert.equal(row.walmartCurrentPrice, 40);
  assert.equal(row.proposedPrice, 55);
  assert.equal(row.updateStatus, 'Failed');
  assert.match(row.errorMessage, /400/);
  assert.equal(row.lastUpdatedAt, null);
});

test('an accepted update stays unverified until the catalog price matches', async () => {
  const store = await tempStore();
  await store.applyFetch([{ sku: 'IS-9-GBA-1', price: 10, currency: 'USD' }], {
    fetchedAt: '2026-10-09T00:00:00.000Z',
    jobId: 'fetch',
  });
  await store.setProposed('IS-9-GBA-1', 14);
  let calls = 0;
  const job = { id: 'job_ok', failures: [] };
  await runPriceUpdates({
    store,
    jobManager: jobs(),
    job,
    scope: 'all',
    filter: {},
    putDelayMs: 0,
    verify: true,
    sleep: async () => {},
    api: {
      async putPrice(sku, amount) {
        assert.equal(sku, 'IS-9-GBA-1');
        assert.equal(amount, 14);
      },
      async getItemPrice() {
        calls += 1;
        return { sku: 'IS-9-GBA-1', price: calls === 1 ? 10 : 14, currency: 'USD' };
      },
    },
  });
  let [row] = await store.list();
  assert.equal(row.walmartCurrentPrice, 10);
  assert.equal(row.updateStatus, 'Unverified');
  assert.equal(row.proposedPrice, 14);

  await store.markVerified('IS-9-GBA-1', {
    price: 14,
    currency: 'USD',
    matched: true,
    at: '2026-10-09T02:00:00.000Z',
  });
  [row] = await store.list();
  assert.equal(row.walmartCurrentPrice, 14);
  assert.equal(row.updateStatus, 'Success');
  assert.equal(row.lastUpdatedAt, '2026-10-09T02:00:00.000Z');
});

test('item pagination stores every page without assuming one response', async () => {
  const store = await tempStore();
  const job = { id: 'job_pages', failures: [] };
  await runFetchPrices({
    store,
    jobManager: jobs(),
    job,
    mode: 'items',
    sleep: async () => {},
    api: {
      async fetchAllItemPages(onProgress) {
        await onProgress({ phase: 'items', message: 'page 1', processed: 1, total: 2 });
        await onProgress({ phase: 'items', message: 'page 2', processed: 2, total: 2 });
        return [
          { sku: 'AAA-1', price: 1, currency: 'USD' },
          { sku: 'MR-2-01FA', price: 2, currency: 'USD' },
        ];
      },
    },
  });
  const query = await store.query({ prefix: 'mr', mrCategory: '01FA', page: 1, pageSize: 50 });
  assert.equal(query.total, 1);
  assert.equal(query.rows[0].sku, 'MR-2-01FA');
  assert.equal(query.rows[0].walmartCurrentPrice, 2);
});

test('catalog json is split into small files and reloads into one sheet', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-shards-'));
  const indexPath = path.join(dir, 'walmart-price-sheet.json');
  const store = createSheetStore(indexPath, { shardSize: 2 });
  await store.applyFetch(
    [
      { sku: 'MR-1-01FA', price: 1, currency: 'USD', productName: 'Chair' },
      { sku: 'MR-2-04HE', price: 2, currency: 'USD', productName: 'Desk' },
      { sku: 'IS-3-GBA-1', price: 3, currency: 'USD', productName: 'Bed' },
    ],
    { fetchedAt: '2026-10-12T00:00:00.000Z', jobId: 'fetch' },
  );
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  assert.equal(index.version, 2);
  assert.equal(index.total, 3);
  assert.equal(index.parts.length, 2);
  assert.equal(index.records, undefined);
  const part = JSON.parse(await fs.readFile(path.join(dir, index.parts[0]), 'utf8'));
  assert.equal(part.records.length, 2);
  const csv = await fs.readFile(path.join(dir, 'walmart-products.csv'), 'utf8');
  assert.match(csv, /MR-1-01FA/);
  const reloaded = createSheetStore(indexPath, { shardSize: 2 });
  const rows = await reloaded.list();
  assert.equal(rows.length, 3);
  const filtered = await reloaded.query({ prefix: 'mr', mrCategory: '01FA' });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.rows[0].sku, 'MR-1-01FA');
});

test('csv export keeps confirmed and proposed prices in separate columns', async () => {
  const store = await tempStore();
  await store.applyFetch([{ sku: 'ABC-1', price: 8, currency: 'USD' }], {
    fetchedAt: '2026-10-09T00:00:00.000Z',
    jobId: 'fetch',
  });
  await store.setProposed('ABC-1', 9);
  const csv = toCsv(await store.filtered({ prefix: 'exclude' }));
  assert.match(csv, /SKU,Walmart Current Price,Proposed Price/);
  assert.match(csv, /ABC-1,8,9/);
  const excluded = await store.filtered({ prefix: 'is' });
  assert.equal(excluded.length, 0);
});
