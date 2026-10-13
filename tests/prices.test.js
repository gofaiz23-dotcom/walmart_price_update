import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyEqual, reducedPrice, validateProposedPrice } from '../src/validation/prices.js';
import { itemRowsFromReportCsv, itemsPagePath, parseCsv } from '../src/walmart/parse.js';
import { priceRowsFromTable, priceRowsFromBuffer } from '../src/store/importSheet.js';
import { createPriceApi } from '../src/walmart/priceApi.js';
import { chunkPriceUpdates, createPriceFeedWindow, priceFeedBody } from '../src/walmart/priceFeed.js';
import { feedItemsFromStatus, feedsFromList } from '../src/walmart/feedStatus.js';
import { exportFileName, exportScope } from '../src/store/exportSheet.js';

test('series downloads use a file name for that sheet', () => {
  assert.equal(exportScope({ prefix: 'is', mrCategory: 'any' }), 'IS');
  assert.equal(exportScope({ prefix: 'mr', mrCategory: 'any' }), 'MR');
  assert.equal(exportScope({ prefix: 'mr', mrCategory: '01FA' }), 'MR-01FA');
  assert.equal(exportScope({ prefix: 'mr', mrCategory: '04HE' }), 'MR-04HE');
  assert.match(exportFileName('xlsx', 'MR-01FA'), /^walmart-prices-MR-01FA-\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test('an uploaded sheet fills Proposed Price and skips blank rows', () => {
  const rows = priceRowsFromTable([
    ['SKU', 'Walmart Current Price', 'Proposed Price', 'Product Name'],
    ['MR-1-01FA', '20', '9.50', 'Chair'],
    ['MR-2-04HE', '10', '', 'Table'],
  ]);
  assert.deepEqual(rows, [{ sku: 'MR-1-01FA', proposedPrice: '9.50' }]);
  assert.throws(() => priceRowsFromTable([['SKU', 'Name'], ['A', 'Chair']]), /Proposed Price/);
});

test('a sample sheet Excel saved with a comment still imports the proposed price', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const { default: JSZip } = await import('jszip');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Prices');
  sheet.addRow(['SKU', 'Walmart Current Price', 'Proposed Price', 'Product Name']);
  sheet.addRow(['MR-1-01FA', 20, 9.5, 'Chair']);
  sheet.getRow(1).getCell(3).note = 'Type the new price in this column.';
  let buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const zip = await JSZip.loadAsync(buffer);
  const relName = 'xl/worksheets/_rels/sheet1.xml.rels';
  const rel = await zip.file(relName).async('string');
  zip.file(relName, rel.replace('../comments1.xml', '/xl/comments1.xml'));
  buffer = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  const broken = new ExcelJS.Workbook();
  await assert.rejects(() => broken.xlsx.load(buffer), /comments/);
  const rows = await priceRowsFromBuffer(buffer, 'walmart-prices-sample.xlsx');
  assert.deepEqual(rows, [{ sku: 'MR-1-01FA', proposedPrice: '9.5' }]);
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

test('item reads follow nextCursor and one or many prices use the bulk price feed', async () => {
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
      if (spec.method === 'POST') return { status: 200, body: { feedId: 'feed-1' } };
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
  await api.submitPriceFeed([
    { sku: 'MR-1-01FA', price: 9.5 },
    { sku: 'IS-2-GBA-1', price: 4 },
  ]);
  const single = calls.at(-2);
  const batch = calls.at(-1);
  assert.equal(single.method, 'POST');
  assert.equal(single.path, '/v3/feeds?feedType=PRICE_AND_PROMOTION');
  assert.equal(single.json.MPItem.length, 1);
  assert.equal(single.json.MPItem[0]['Promo&Discount'].sku, 'MR-1-01FA');
  assert.equal(single.json.MPItem[0]['Promo&Discount'].price, 9.5);
  assert.equal(batch.json.MPItem.length, 2);
  assert.equal(batch.json.MPItem[1]['Promo&Discount'].price, 4);
});

test('price feeds stay at 1000 products and under 10 MB', () => {
  const items = Array.from({ length: 1001 }, (_, index) => ({ sku: `SKU-${index}`, price: 10 }));
  const chunks = chunkPriceUpdates(items);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 1000);
  assert.equal(chunks[1].length, 1);
  const tiny = chunkPriceUpdates(
    [
      { sku: 'A', price: 1 },
      { sku: 'B', price: 2 },
    ],
    { maxBytes: Buffer.byteLength(JSON.stringify(priceFeedBody([{ sku: 'A', price: 1 }]))) },
  );
  assert.equal(tiny.length, 2);
});

test('an 11th price feed waits until the hourly window has room', async () => {
  let now = 0;
  const window = createPriceFeedWindow({
    callsPerHour: 2,
    windowMs: 1000,
    now: () => now,
  });
  const sleep = async (ms) => {
    now += ms;
  };
  assert.equal(await window.acquire(sleep), 0);
  assert.equal(await window.acquire(sleep), 0);
  const waited = await window.acquire(sleep);
  assert.equal(waited, 1000);
  assert.equal(window.times.length, 1);
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

test('price feed status reads the list and each item page', async () => {
  const listed = feedsFromList({
    results: { feed: [{ feedId: 'ABC@1', feedStatus: 'PROCESSED', itemsSucceeded: 1, itemsFailed: 1 }] },
  });
  assert.equal(listed[0].feedId, 'ABC@1');
  const items = feedItemsFromStatus({
    itemDetails: {
      itemIngestionStatus: [
        { sku: 'MR-1', ingestionStatus: 'SUCCESS' },
        { sku: 'MR-2', ingestionStatus: 'DATA_ERROR', ingestionErrors: { ingestionError: [{ description: 'Bad price' }] } },
      ],
    },
  });
  assert.equal(items[1].error, 'Bad price');

  const calls = [];
  const api = createPriceApi({
    async request(spec) {
      calls.push(spec.path);
      if (spec.path.includes('feedType=PRICE_AND_PROMOTION')) {
        return { status: 200, body: { results: { feed: listed } } };
      }
      const offset = Number(new URL(`https://walmart.test${spec.path}`).searchParams.get('offset'));
      return {
        status: 200,
        body: {
          feedId: 'ABC@1',
          feedStatus: 'PROCESSED',
          itemsReceived: 2,
          itemsSucceeded: 1,
          itemsFailed: 1,
          itemDetails: {
            itemIngestionStatus: [offset === 0 ? items[0] : items[1]],
          },
        },
      };
    },
  });
  const feeds = await api.listPriceFeeds();
  assert.equal(feeds[0].feedStatus, 'PROCESSED');
  const status = await api.getPriceFeedStatus('ABC@1');
  assert.equal(status.itemDetails.itemIngestionStatus.length, 2);
  assert.match(calls[1], /includeDetails=true/);
  assert.match(calls[1], /ABC%401/);
});
