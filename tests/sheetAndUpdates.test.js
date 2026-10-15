import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSheetStore } from '../src/store/sheetStore.js';
import { toCsv } from '../src/store/exportSheet.js';
import { runFetchPrices } from '../src/services/fetchPrices.js';
import { runFetchInventory } from '../src/services/fetchInventory.js';
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

test('an uploaded price sheet updates known SKUs only', async () => {
  const store = await tempStore();
  await store.applyFetch(
    [
      { sku: 'MR-1-01FA', price: 20, currency: 'USD', productName: 'Chair' },
      { sku: 'IS-1-GBA-1', price: 8, currency: 'USD' },
    ],
    { fetchedAt: '2026-10-13T00:00:00.000Z', jobId: 'a' },
  );
  const result = await store.applyImportedPrices([
    { sku: 'mr-1-01fa', proposedPrice: '9.50' },
    { sku: 'IS-1-GBA-1', proposedPrice: '8' },
    { sku: 'MISSING-1', proposedPrice: '4' },
  ]);
  assert.equal(result.updated, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.unknown, 1);
  assert.deepEqual(result.skus, ['MR-1-01FA']);
  const rows = await store.list();
  assert.equal(rows.find((row) => row.sku === 'MR-1-01FA').proposedPrice, 9.5);
  assert.equal(rows.find((row) => row.sku === 'IS-1-GBA-1').proposedPrice, 8);
});

test('a blank proposed price clears one that was already saved', async () => {
  const store = await tempStore();
  await store.applyFetch(
    [{ sku: 'MR-1-01FA', price: 20, currency: 'USD' }],
    { fetchedAt: '2026-10-13T00:00:00.000Z', jobId: 'a' },
  );
  await store.setProposed('MR-1-01FA', 9.5);
  const cleared = await store.setProposed('MR-1-01FA', '');
  assert.equal(cleared.proposedPrice, null);
  assert.equal(cleared.updateStatus, '');
  const rows = await store.list();
  assert.equal(rows.find((row) => row.sku === 'MR-1-01FA').proposedPrice, null);
  assert.equal(rows.find((row) => row.sku === 'MR-1-01FA').walmartCurrentPrice, 20);
});

test('clearing proposed prices empties the selected series only', async () => {
  const store = await tempStore();
  await store.applyFetch(
    [
      { sku: 'MR-1-01FA', price: 20, currency: 'USD' },
      { sku: 'MR-2-04HE', price: 10, currency: 'USD' },
      { sku: 'IS-1-GBA-1', price: 8, currency: 'USD' },
    ],
    { fetchedAt: '2026-10-13T00:00:00.000Z', jobId: 'a' },
  );
  await store.setProposed('MR-1-01FA', 9);
  await store.setProposed('MR-2-04HE', 7);
  await store.setProposed('IS-1-GBA-1', 6);
  const result = await store.clearProposed({ prefix: 'mr', mrCategory: 'any' });
  assert.equal(result.cleared, 2);
  const rows = await store.list();
  assert.equal(rows.find((row) => row.sku === 'MR-1-01FA').proposedPrice, null);
  assert.equal(rows.find((row) => row.sku === 'MR-2-04HE').proposedPrice, null);
  assert.equal(rows.find((row) => row.sku === 'IS-1-GBA-1').proposedPrice, 6);
  assert.equal(rows.find((row) => row.sku === 'MR-1-01FA').walmartCurrentPrice, 20);
});

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
      async submitPriceFeed() {
        throw new Error('Walmart price feed failed (400)');
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
  const feeds = [];
  const job = { id: 'job_ok', failures: [] };
  await runPriceUpdates({
    store,
    jobManager: jobs(),
    job,
    scope: 'all',
    filter: {},
    sleep: async () => {},
    api: {
      async submitPriceFeed(items) {
        feeds.push(items);
        return { feedId: 'feed-1', itemCount: items.length };
      },
      async getItemPrice() {
        calls += 1;
        return { sku: 'IS-9-GBA-1', price: 14, currency: 'USD' };
      },
    },
  });
  let [row] = await store.list();
  assert.equal(feeds.length, 1);
  assert.deepEqual(feeds[0], [{ sku: 'IS-9-GBA-1', price: 14 }]);
  assert.equal(calls, 0);
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

test('saved feed status marks a rejected price and keeps an accepted one', async () => {
  const store = await tempStore();
  await store.applyFetch(
    [
      { sku: 'MR-1-01FA', price: 20, currency: 'USD' },
      { sku: 'MR-2-01FA', price: 30, currency: 'USD' },
    ],
    { fetchedAt: '2026-10-13T00:00:00.000Z', jobId: 'fetch' },
  );
  await store.setProposedMany([
    { sku: 'MR-1-01FA', proposedPrice: 10 },
    { sku: 'MR-2-01FA', proposedPrice: 30 },
  ]);
  const applied = await store.applyFeedResults('FEED1', [
    { sku: 'MR-1-01FA', ingestionStatus: 'DATA_ERROR', error: 'Bad price' },
    { sku: 'mr-2-01fa', ingestionStatus: 'SUCCESS', error: '' },
    { sku: 'MR-1-01FA', ingestionStatus: 'INPROGRESS', error: '' },
  ]);
  assert.equal(applied.matched, 3);
  const rows = await store.list();
  const failed = rows.find((row) => row.sku === 'MR-1-01FA');
  const same = rows.find((row) => row.sku === 'MR-2-01FA');
  assert.equal(failed.updateStatus, 'Unverified');
  assert.equal(failed.feedItemStatus, 'INPROGRESS');
  assert.equal(failed.errorMessage, '');
  assert.equal(same.updateStatus, 'Success');
  assert.equal(same.feedItemStatus, 'SUCCESS');
  assert.equal(same.walmartCurrentPrice, 30);
});

test('inventory fetch stores available quantity and leaves the price alone', async () => {
  const store = await tempStore();
  await store.applyFetch(
    [{ sku: 'MR-1-01FA', price: 20, currency: 'USD', productName: 'Chair' }],
    { fetchedAt: '2026-10-13T00:00:00.000Z', jobId: 'fetch' },
  );
  await store.setProposed('MR-1-01FA', 18);
  const applied = await store.applyInventory(
    [{ sku: 'mr-1-01fa', available: 11, input: 14, nodes: [{ shipNode: 'N1', available: 11, input: 14 }], productName: 'Other' }],
    { fetchedAt: '2026-10-15T00:00:00.000Z', jobId: 'inv' },
  );
  assert.equal(applied.updated, 1);
  assert.equal(applied.added, 0);
  const row = (await store.list()).find((item) => item.sku === 'MR-1-01FA');
  assert.equal(row.inventoryAvailable, 11);
  assert.equal(row.inventoryInput, 14);
  assert.equal(row.walmartCurrentPrice, 20);
  assert.equal(row.proposedPrice, 18);
  assert.equal(row.productName, 'Chair');
  const summary = await store.summary();
  assert.equal(summary.withInventory, 1);
  const job = { id: 'job-inv', message: '' };
  const result = await runFetchInventory({
    store,
    job,
    jobManager: jobs(),
    pollMs: 1,
    timeoutMs: 1000,
    sleep: async () => {},
    resume: false,
    api: {
      async fetchAllInventoryPages(onProgress) {
        const pageRows = [{ sku: 'IS-9', available: 4, input: 5, nodes: [], productName: '' }];
        await onProgress({ message: 'page 1', processed: 1, total: 1, pageRows });
        return pageRows;
      },
    },
  });
  assert.equal(result.totalRows, 1);
  assert.equal(result.source, 'inventories');
  const added = (await store.list()).find((item) => item.sku === 'IS-9');
  assert.equal(added.inventoryAvailable, 4);
  assert.equal(added.walmartCurrentPrice, null);
});
