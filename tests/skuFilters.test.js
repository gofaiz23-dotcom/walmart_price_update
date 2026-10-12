import test from 'node:test';
import assert from 'node:assert/strict';
import { countFilters, matchesFilter, mrSuffix, prefixGroup, sheetDownloadCounts } from '../src/filters/skuFilters.js';

const rows = [
  { sku: 'MR-123-01FA' },
  { sku: 'mr-999-04he' },
  { sku: 'MR-50-01FA-EXTRA' },
  { sku: 'IS-22177-GBA-1' },
  { sku: 'is-10-gba-1' },
  { sku: 'ABC-100' },
  { sku: 'XX-01FA' },
];

test('prefix groups are case-insensitive', () => {
  assert.equal(prefixGroup('MR-123-01FA'), 'mr');
  assert.equal(prefixGroup('is-22177-GBA-1'), 'is');
  assert.equal(prefixGroup('ABC-100'), 'other');
});

test('MR suffix matches only the end of the SKU', () => {
  assert.equal(mrSuffix('MR-123-01FA'), '01FA');
  assert.equal(mrSuffix('mr-999-04he'), '04HE');
  assert.equal(mrSuffix('MR-50-01FA-EXTRA'), '');
  assert.equal(mrSuffix('MR-01FA-100'), '');
  assert.equal(mrSuffix('XX-01FA'), '01FA');
});

test('primary filters and MR categories combine', () => {
  const all = rows.filter((row) => matchesFilter(row, { prefix: 'all', mrCategory: 'any' }));
  assert.equal(all.length, 7);
  const mr = rows.filter((row) => matchesFilter(row, { prefix: 'mr', mrCategory: 'any' }));
  assert.deepEqual(mr.map((row) => row.sku), ['MR-123-01FA', 'mr-999-04he', 'MR-50-01FA-EXTRA']);
  const isOnly = rows.filter((row) => matchesFilter(row, { prefix: 'is', mrCategory: 'any' }));
  assert.equal(isOnly.length, 2);
  const excluded = rows.filter((row) => matchesFilter(row, { prefix: 'exclude', mrCategory: 'any' }));
  assert.deepEqual(excluded.map((row) => row.sku), ['ABC-100', 'XX-01FA']);
  const fa = rows.filter((row) => matchesFilter(row, { prefix: 'all', mrCategory: '01FA' }));
  assert.deepEqual(fa.map((row) => row.sku), ['MR-123-01FA', 'XX-01FA']);
  const mrFa = rows.filter((row) => matchesFilter(row, { prefix: 'mr', mrCategory: '01FA' }));
  assert.deepEqual(mrFa.map((row) => row.sku), ['MR-123-01FA']);
  const isFa = rows.filter((row) => matchesFilter(row, { prefix: 'is', mrCategory: '01FA' }));
  assert.equal(isFa.length, 0);
  const he = rows.filter((row) => matchesFilter(row, { prefix: 'mr', mrCategory: '04HE' }));
  assert.deepEqual(he.map((row) => row.sku), ['mr-999-04he']);
});

test('search matches partial SKUs and counts follow the active filters', () => {
  const found = rows.filter((row) => matchesFilter(row, { prefix: 'all', mrCategory: 'any', q: '22177' }));
  assert.equal(found.length, 1);
  const counts = countFilters(rows, { prefix: 'mr', mrCategory: 'any', q: '' });
  assert.equal(counts.mr, 3);
  assert.equal(counts.fa, 1);
  assert.equal(counts.he, 1);
  const sheets = sheetDownloadCounts(rows);
  assert.deepEqual(sheets, { is: 2, mr: 3, fa: 1, he: 1 });
});
