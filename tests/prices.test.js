import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyEqual, reducedPrice, validateProposedPrice } from '../src/validation/prices.js';
import { itemRowsFromReportCsv, itemsPagePath, parseCsv } from '../src/walmart/parse.js';
import { createPriceApi } from '../src/walmart/priceApi.js';
import { exportFileName, exportScope } from '../src/store/exportSheet.js';

test('series downloads use a file name for that sheet', () => {
  assert.equal(exportScope({ prefix: 'is', mrCategory: 'any' }), 'IS');
  assert.equal(exportScope({ prefix: 'mr', mrCategory: 'any' }), 'MR');
  assert.equal(exportScope({ prefix: 'mr', mrCategory: '01FA' }), 'MR-01FA');
  assert.equal(exportScope({ prefix: 'mr', mrCategory: '04HE' }), 'MR-04HE');
  assert.match(exportFileName('xlsx', 'MR-01FA'), /^walmart-prices-MR-01FA-\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test('a 50 percent reduction halves the current price', () => {
  assert.equal(reducedPrice(20, 50), 10);
  assert.equal(reducedPrice(19.99, 50), 10);
  assert.equal(reducedPrice(0.01, 50), null);
  assert.equal(reducedPrice(20, 100), null);
});

test('proposed prices must be positive amounts with at most 2 decimals', () => {
  assert.equal(validateProposedPrice('12.5').amount, 12.5);
  assert.equal(validateProposedPrice('0').ok, false);
  assert.equal(validateProposedPrice('-3').ok, false);
  assert.equal(validateProposedPrice('1.999').ok, false);
  assert.equal(validateProposedPrice('abc').ok, false);
  assert.equal(moneyEqual(10, 10.004), true);
});

test('ITEM report CSV maps SKU and price, including quoted fields', () => {
  const csv = 'SKU,Price,Currency,Product Name\nMR-123-01FA,19.99,USD,"Chair, red"\nIS-1-GBA-1,,USD,Missing\n';
  const rows = itemRowsFromReportCsv(parseCsv(csv));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { sku: 'MR-123-01FA', price: 19.99, currency: 'USD', productName: 'Chair, red' });
  assert.equal(rows[1].price, null);
});

test('a Walmart query-string cursor is sent as the next page, not nested again', () => {
  assert.equal(itemsPagePath('*', 1000), '/v3/items?limit=1000&nextCursor=*');
  assert.match(itemsPagePath('?limit=1000&offset=2000', 1000), /offset=2000/);
  assert.doesNotMatch(itemsPagePath('?limit=1000&offset=2000', 1000), /nextCursor=%3F/);
});

test('item reads follow nextCursor and price updates use PUT /v3/price', async () => {
  const calls = [];
  const pages = [
    {
      body: {
        ItemResponse: [{ sku: 'MR-1-01FA', price: { currency: 'USD', amount: 3 } }],
        nextCursor: 'cursor-2',
      },
    },
    {
      body: {
        ItemResponse: [{ sku: 'IS-2-GBA-1', price: { currency: 'USD', amount: 4 } }],
      },
    },
  ];
  let page = 0;
  const api = createPriceApi({
    async request(spec) {
      calls.push(spec);
      if (spec.method === 'PUT') return { status: 200, body: {} };
      return pages[page++];
    },
  });
  const rows = await api.fetchAllItemPages(async () => {}, { pageSize: 1, delayMs: 0, sleep: async () => {} });
  assert.deepEqual(rows.map((row) => [row.sku, row.price]), [
    ['MR-1-01FA', 3],
    ['IS-2-GBA-1', 4],
  ]);
  assert.match(calls[0].path, /nextCursor=\*/);
  assert.match(calls[1].path, /nextCursor=cursor-2/);
  await api.putPrice('MR-1-01FA', 9.5, 'USD');
  const put = calls.at(-1);
  assert.equal(put.method, 'PUT');
  assert.equal(put.path, '/v3/price');
  assert.equal(put.json.pricing[0].currentPriceType, 'BASE');
  assert.equal(put.json.pricing[0].currentPrice.amount, 9.5);
});

test('Walmart reuses one nextCursor, so the same token is sent until the catalog is complete', async () => {
  const calls = [];
  const skus = ['A', 'B', 'C'];
  let page = 0;
  const api = createPriceApi({
    async request(spec) {
      calls.push(spec.path);
      const sku = skus[page++];
      return {
        status: 200,
        body: {
          totalItems: skus.length,
          nextCursor: 'same-cursor',
          ItemResponse: [{ sku, price: { currency: 'USD', amount: page } }],
        },
      };
    },
  });
  const rows = await api.fetchAllItemPages(async () => {}, { pageSize: 1, delayMs: 0, sleep: async () => {} });
  assert.deepEqual(rows.map((row) => row.sku), skus);
  assert.equal(calls.length, 3);
  assert.match(calls[1], /nextCursor=same-cursor/);
  assert.match(calls[2], /nextCursor=same-cursor/);
  assert.equal(calls.some((path) => path.includes('offset=')), false);
});
