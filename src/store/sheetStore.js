import fs from 'node:fs/promises';
import path from 'node:path';
import { compareRecords, countFilters, matchesFilter, normalizeFilter, sheetDownloadCounts } from '../filters/skuFilters.js';
import { moneyEqual, parsePercentOff, priceDifference, reducedPrice, validateProposedPrice } from '../validation/prices.js';
import { isProcessingStatus } from '../walmart/feedStatus.js';
import { toCsv } from './exportSheet.js';

function createMutex() {
  let tail = Promise.resolve();
  return function exclusive(fn) {
    const run = tail.then(() => fn());
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

function blankRecord(sku) {
  return {
    sku,
    productName: '',
    walmartCurrentPrice: null,
    currency: 'USD',
    proposedPrice: null,
    lastFetchedAt: null,
    lastUpdatedAt: null,
    updateStatus: '',
    errorMessage: '',
    lastSubmittedPrice: null,
    lastJobId: '',
    feedId: '',
    feedItemStatus: '',
    inventoryAvailable: null,
    inventoryInput: null,
    inventoryNodes: [],
    inventoryFetchedAt: null,
  };
}

export function isEligible(record) {
  if (record?.proposedPrice == null) return false;
  if (record.walmartCurrentPrice == null) return true;
  return !moneyEqual(record.proposedPrice, record.walmartCurrentPrice);
}

export function toPublicRow(record) {
  return {
    sku: record.sku,
    productName: record.productName || '',
    walmartCurrentPrice: record.walmartCurrentPrice,
    proposedPrice: record.proposedPrice,
    priceDifference: priceDifference(record.walmartCurrentPrice, record.proposedPrice),
    currency: record.currency || 'USD',
    lastFetchedAt: record.lastFetchedAt,
    lastUpdatedAt: record.lastUpdatedAt,
    updateStatus: record.updateStatus || '',
    errorMessage: record.errorMessage || '',
    lastSubmittedPrice: record.lastSubmittedPrice,
    feedId: record.feedId || '',
    feedItemStatus: record.feedItemStatus || '',
    inventoryAvailable: record.inventoryAvailable ?? null,
    inventoryInput: record.inventoryInput ?? null,
    inventoryFetchedAt: record.inventoryFetchedAt || null,
    eligible: isEligible(record),
  };
}

const DEFAULT_SHARD_SIZE = 250;

export function createSheetStore(filePath, { shardSize = DEFAULT_SHARD_SIZE } = {}) {
  const exclusive = createMutex();
  /** @type {Map<string, object>} */
  let bySku = new Map();
  /** @type {Map<string, string>} */
  let lowerIndex = new Map();
  let loaded = false;

  function reindex() {
    lowerIndex = new Map();
    for (const sku of bySku.keys()) {
      lowerIndex.set(sku.toLowerCase(), sku);
    }
  }

  function canonicalKey(sku) {
    const exact = String(sku || '').trim();
    if (!exact) return '';
    if (bySku.has(exact)) return exact;
    return lowerIndex.get(exact.toLowerCase()) || '';
  }

  function remember(row) {
    const sku = String(row?.sku || '').trim();
    if (!sku) return;
    const existingKey = canonicalKey(sku);
    if (existingKey) return;
    bySku.set(sku, { ...blankRecord(sku), ...row, sku });
    lowerIndex.set(sku.toLowerCase(), sku);
  }

  async function readJson(target) {
    const text = await fs.readFile(target, 'utf8');
    return JSON.parse(text);
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    bySku = new Map();
    lowerIndex = new Map();
    let legacy = false;
    try {
      const parsed = await readJson(filePath);
      if (parsed?.version === 2 && Array.isArray(parsed.parts)) {
        for (const part of parsed.parts) {
          const partPath = path.join(path.dirname(filePath), part);
          const body = await readJson(partPath);
          const list = Array.isArray(body?.records) ? body.records : [];
          for (const row of list) remember(row);
        }
      } else {
        const list = Array.isArray(parsed?.records) ? parsed.records : [];
        for (const row of list) remember(row);
        legacy = list.length > 0;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (legacy) await persist();
  }

  async function persist() {
    const records = [...bySku.values()].sort((a, b) => a.sku.localeCompare(b.sku));
    const dir = path.dirname(filePath);
    const partsDir = path.join(dir, 'parts');
    await fs.mkdir(partsDir, { recursive: true });
    const size = Math.max(1, Number(shardSize) || DEFAULT_SHARD_SIZE);
    const parts = [];
    for (let index = 0; index < records.length; index += size) {
      const chunk = records.slice(index, index + size);
      const name = `products-${String(parts.length + 1).padStart(4, '0')}.json`;
      parts.push(`parts/${name}`);
      const body = `${JSON.stringify({ records: chunk }, null, 2)}\n`;
      const target = path.join(partsDir, name);
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(tmp, body);
      await fs.copyFile(tmp, target);
      await fs.rm(tmp, { force: true });
    }
    const existing = await fs.readdir(partsDir).catch(() => []);
    const keep = new Set(parts.map((part) => path.basename(part)));
    for (const name of existing) {
      if (!keep.has(name) && name.endsWith('.json')) {
        await fs.rm(path.join(partsDir, name), { force: true });
      }
    }
    const index = {
      version: 2,
      updatedAt: new Date().toISOString(),
      total: records.length,
      shardSize: size,
      parts,
      note: 'Product rows are in parts/. This index stays small so it can be opened safely. Filters run on this saved catalog.',
    };
    const indexTmp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(indexTmp, `${JSON.stringify(index, null, 2)}\n`);
    await fs.copyFile(indexTmp, filePath);
    await fs.rm(indexTmp, { force: true });
    await fs.writeFile(path.join(dir, 'walmart-products.csv'), toCsv(records.map((record) => ({
      ...record,
      productName: record.productName || '',
    }))));
  }

  function all() {
    return [...bySku.values()];
  }

  function get(sku) {
    const key = canonicalKey(sku);
    return key ? bySku.get(key) : null;
  }

  return {
    filePath,
    exclusive,
    async ensure() {
      return exclusive(async () => {
        await load();
      });
    },
    async list() {
      return exclusive(async () => {
        await load();
        return all();
      });
    },
    async summary(filterInput = {}) {
      return exclusive(async () => {
        await load();
        const records = all();
        const filter = normalizeFilter({ ...filterInput, sort: 'sku', dir: 'asc' });
        let withPrice = 0;
        let withInventory = 0;
        let pending = 0;
        let success = 0;
        let failed = 0;
        let unverified = 0;
        let eligible = 0;
        let lastFetchedAt = null;
        let lastInventoryFetchedAt = null;
        for (const record of records) {
          if (record.walmartCurrentPrice != null) withPrice += 1;
          if (record.inventoryAvailable != null) withInventory += 1;
          if (record.updateStatus === 'Pending') pending += 1;
          if (record.updateStatus === 'Success') success += 1;
          if (record.updateStatus === 'Failed') failed += 1;
          if (record.updateStatus === 'Unverified') unverified += 1;
          if (isEligible(record)) eligible += 1;
          if (record.lastFetchedAt && (!lastFetchedAt || record.lastFetchedAt > lastFetchedAt)) {
            lastFetchedAt = record.lastFetchedAt;
          }
          if (record.inventoryFetchedAt && (!lastInventoryFetchedAt || record.inventoryFetchedAt > lastInventoryFetchedAt)) {
            lastInventoryFetchedAt = record.inventoryFetchedAt;
          }
        }
        return {
          total: records.length,
          withPrice,
          withInventory,
          pending,
          success,
          failed,
          unverified,
          eligible,
          lastFetchedAt,
          lastInventoryFetchedAt,
          counts: countFilters(records, filter),
          sheets: sheetDownloadCounts(records),
          matched: records.filter((record) => matchesFilter(record, filter)).length,
        };
      });
    },
    async query(filterInput = {}) {
      return exclusive(async () => {
        await load();
        const filter = normalizeFilter(filterInput);
        const page = Math.max(1, Number(filterInput.page) || 1);
        const pageSize = Math.min(200, Math.max(1, Number(filterInput.pageSize) || 50));
        const matched = all()
          .filter((record) => matchesFilter(record, filter))
          .sort((a, b) => compareRecords(a, b, filter.sort, filter.dir));
        const start = (page - 1) * pageSize;
        return {
          page,
          pageSize,
          total: matched.length,
          rows: matched.slice(start, start + pageSize).map(toPublicRow),
          counts: countFilters(all(), filter),
        };
      });
    },
    async filtered(filterInput = {}) {
      return exclusive(async () => {
        await load();
        const filter = normalizeFilter(filterInput);
        return all()
          .filter((record) => matchesFilter(record, filter))
          .sort((a, b) => compareRecords(a, b, filter.sort, filter.dir))
          .map(toPublicRow);
      });
    },
    /**
     * Merge fetched Walmart prices. Confirmed current price is never replaced
     * by an empty value. Proposed prices are left untouched.
     */
    async applyFetch(rows, { fetchedAt, jobId }) {
      return exclusive(async () => {
        await load();
        let updated = 0;
        let missingPrice = 0;
        let added = 0;
        for (const row of rows) {
          const incoming = String(row?.sku || '').trim();
          if (!incoming) continue;
          let key = canonicalKey(incoming);
          if (!key) {
            key = incoming;
            bySku.set(key, blankRecord(key));
            lowerIndex.set(key.toLowerCase(), key);
            added += 1;
          }
          const record = bySku.get(key);
          if (row.productName) record.productName = row.productName;
          if (row.price == null) {
            missingPrice += 1;
            continue;
          }
          record.walmartCurrentPrice = row.price;
          record.currency = row.currency || record.currency || 'USD';
          record.lastFetchedAt = fetchedAt;
          record.lastJobId = jobId || record.lastJobId;
          if (record.updateStatus === 'Unverified' && record.proposedPrice != null) {
            if (moneyEqual(record.walmartCurrentPrice, record.proposedPrice)) {
              record.updateStatus = 'Success';
              record.lastUpdatedAt = fetchedAt;
              record.errorMessage = '';
            } else {
              record.errorMessage = 'Fetched Walmart price does not match the proposed price yet.';
            }
          }
          updated += 1;
        }
        await persist();
        return { updated, missingPrice, added, total: bySku.size };
      });
    },
    /**
     * Merge fetched Walmart inventory. Prices and proposed prices stay as they are.
     * Available quantity is the sum of AvailToSell across ship nodes.
     */
    async applyInventory(rows, { fetchedAt, jobId }) {
      return exclusive(async () => {
        await load();
        let updated = 0;
        let added = 0;
        for (const row of rows) {
          const incoming = String(row?.sku || '').trim();
          if (!incoming) continue;
          let key = canonicalKey(incoming);
          if (!key) {
            key = incoming;
            bySku.set(key, blankRecord(key));
            lowerIndex.set(key.toLowerCase(), key);
            added += 1;
          }
          const record = bySku.get(key);
          if (row.productName && !record.productName) record.productName = row.productName;
          record.inventoryAvailable = row.available == null ? null : Number(row.available);
          record.inventoryInput = row.input == null ? null : Number(row.input);
          record.inventoryNodes = Array.isArray(row.nodes) ? row.nodes : [];
          record.inventoryFetchedAt = fetchedAt;
          record.lastJobId = jobId || record.lastJobId;
          updated += 1;
        }
        await persist();
        return { updated, added, total: bySku.size };
      });
    },
    async setProposed(sku, rawPrice, { maxPrice } = {}) {
      return exclusive(async () => {
        await load();
        const incoming = String(sku || '').trim();
        if (!incoming) {
          const error = new Error('SKU is required.');
          error.statusCode = 400;
          throw error;
        }
        const clearing = rawPrice == null || String(rawPrice).trim() === '';
        if (clearing) {
          const key = canonicalKey(incoming);
          if (!key) {
            const error = new Error('SKU was not found.');
            error.statusCode = 404;
            throw error;
          }
          const record = bySku.get(key);
          record.proposedPrice = null;
          if (record.updateStatus === 'Pending' || record.updateStatus === 'Failed') {
            record.updateStatus = '';
            record.errorMessage = '';
          }
          await persist();
          return toPublicRow(record);
        }
        const check = validateProposedPrice(rawPrice, { maxPrice });
        if (!check.ok) {
          const error = new Error(check.message);
          error.statusCode = 400;
          throw error;
        }
        let key = canonicalKey(incoming);
        if (!key) {
          key = incoming;
          bySku.set(key, blankRecord(key));
          lowerIndex.set(key.toLowerCase(), key);
        }
        const record = bySku.get(key);
        record.proposedPrice = check.amount;
        if (moneyEqual(record.walmartCurrentPrice, check.amount)) {
          if (record.updateStatus === 'Pending' || record.updateStatus === 'Failed') {
            record.updateStatus = record.lastUpdatedAt ? 'Success' : '';
            record.errorMessage = '';
          }
        } else {
          record.updateStatus = 'Pending';
          record.errorMessage = '';
        }
        await persist();
        return toPublicRow(record);
      });
    },
    async adjustByPercent(filterInput, percentOff, { maxPrice } = {}) {
      return exclusive(async () => {
        await load();
        const percent = parsePercentOff(percentOff);
        if (percent == null) {
          const error = new Error('Enter a reduction greater than 0 and less than 100 percent.');
          error.statusCode = 400;
          throw error;
        }
        const filter = normalizeFilter({ ...filterInput, sort: 'sku', dir: 'asc' });
        let updated = 0;
        let skipped = 0;
        const sample = [];
        for (const record of all()) {
          if (!matchesFilter(record, filter)) continue;
          const next = reducedPrice(record.walmartCurrentPrice, percent);
          const check = next == null ? { ok: false } : validateProposedPrice(next, { maxPrice });
          if (!check.ok || moneyEqual(record.walmartCurrentPrice, check.amount)) {
            skipped += 1;
            continue;
          }
          record.proposedPrice = check.amount;
          record.updateStatus = 'Pending';
          record.errorMessage = '';
          updated += 1;
          if (sample.length < 8) {
            sample.push({
              sku: record.sku,
              walmartCurrentPrice: record.walmartCurrentPrice,
              proposedPrice: check.amount,
            });
          }
        }
        if (updated) await persist();
        return { updated, skipped, percent, sample };
      });
    },
    async clearProposed(filterInput) {
      return exclusive(async () => {
        await load();
        const filter = normalizeFilter({ ...filterInput, sort: 'sku', dir: 'asc' });
        let cleared = 0;
        for (const record of all()) {
          if (!matchesFilter(record, filter)) continue;
          if (record.proposedPrice == null) continue;
          record.proposedPrice = null;
          if (record.updateStatus === 'Pending' || record.updateStatus === 'Failed') {
            record.updateStatus = '';
            record.errorMessage = '';
          }
          cleared += 1;
        }
        if (cleared) await persist();
        return { cleared };
      });
    },
    async applyImportedPrices(entries, { maxPrice } = {}) {
      return exclusive(async () => {
        await load();
        let updated = 0;
        let skipped = 0;
        let unknown = 0;
        let invalid = 0;
        const skus = [];
        const unknownSample = [];
        const invalidSample = [];
        for (const entry of entries || []) {
          const incoming = String(entry?.sku || '').trim();
          const key = canonicalKey(incoming);
          if (!incoming || !key) {
            if (incoming) {
              unknown += 1;
              if (unknownSample.length < 8) unknownSample.push(incoming);
            }
            continue;
          }
          const check = validateProposedPrice(entry?.proposedPrice, { maxPrice });
          if (!check.ok) {
            invalid += 1;
            if (invalidSample.length < 8) invalidSample.push({ sku: incoming, message: check.message });
            continue;
          }
          const record = bySku.get(key);
          if (moneyEqual(record.proposedPrice, check.amount)) {
            skipped += 1;
            continue;
          }
          const sameAsCurrent = moneyEqual(record.walmartCurrentPrice, check.amount);
          record.proposedPrice = check.amount;
          if (sameAsCurrent) {
            if (record.updateStatus === 'Pending' || record.updateStatus === 'Failed') {
              record.updateStatus = record.lastUpdatedAt ? 'Success' : '';
              record.errorMessage = '';
            }
          } else {
            record.updateStatus = 'Pending';
            record.errorMessage = '';
            skus.push(record.sku);
          }
          updated += 1;
        }
        if (updated) await persist();
        return { updated, skipped, unknown, invalid, skus, unknownSample, invalidSample };
      });
    },
    async setProposedMany(updates, { maxPrice } = {}) {
      return exclusive(async () => {
        await load();
        const saved = [];
        const errors = [];
        for (const update of updates || []) {
          const check = validateProposedPrice(update?.proposedPrice, { maxPrice });
          const incoming = String(update?.sku || '').trim();
          if (!incoming || !check.ok) {
            errors.push({ sku: incoming, message: check.ok ? 'SKU is required.' : check.message });
            continue;
          }
          let key = canonicalKey(incoming);
          if (!key) {
            key = incoming;
            bySku.set(key, blankRecord(key));
            lowerIndex.set(key.toLowerCase(), key);
          }
          const record = bySku.get(key);
          record.proposedPrice = check.amount;
          record.updateStatus = 'Pending';
          record.errorMessage = '';
          saved.push(toPublicRow(record));
        }
        await persist();
        return { saved, errors };
      });
    },
    async restoreConnectionFailures() {
      return exclusive(async () => {
        await load();
        let restored = 0;
        for (const record of all()) {
          if (record.updateStatus !== 'Failed') continue;
          if (!/^fetch failed\b/i.test(record.errorMessage || '')) continue;
          record.updateStatus = record.proposedPrice != null ? 'Pending' : '';
          record.errorMessage = '';
          restored += 1;
        }
        if (restored) await persist();
        return { restored };
      });
    },
    async applyFeedResults(feedId, items) {
      return exclusive(async () => {
        await load();
        let matched = 0;
        for (const item of items || []) {
          const key = canonicalKey(item.sku);
          if (!key) continue;
          const record = bySku.get(key);
          matched += 1;
          record.feedId = feedId;
          record.feedItemStatus = item.ingestionStatus || '';
          if (item.ingestionStatus === 'SUCCESS') {
            record.errorMessage = item.error || '';
            if (record.proposedPrice != null && moneyEqual(record.proposedPrice, record.walmartCurrentPrice)) {
              record.updateStatus = 'Success';
            } else if (record.updateStatus === 'Failed') {
              record.updateStatus = 'Unverified';
            }
          } else if (isProcessingStatus(item.ingestionStatus)) {
            record.errorMessage = '';
            if (record.updateStatus === 'Failed') record.updateStatus = 'Unverified';
          } else {
            record.updateStatus = 'Failed';
            record.errorMessage = item.error || item.ingestionStatus || 'Walmart rejected this price.';
          }
        }
        if (matched) await persist();
        return { matched };
      });
    },
    async markSubmittedMany(entries, { jobId, feedId } = {}) {
      return exclusive(async () => {
        await load();
        for (const entry of entries || []) {
          const key = canonicalKey(entry?.sku);
          if (!key) continue;
          const record = bySku.get(key);
          record.lastJobId = jobId || record.lastJobId;
          if (feedId) record.feedId = feedId;
          if (entry.accepted) {
            record.updateStatus = 'Unverified';
            record.errorMessage = '';
            record.lastSubmittedPrice = entry.submittedPrice;
          } else {
            record.updateStatus = 'Failed';
            record.errorMessage = entry.message || 'Walmart rejected the price update.';
          }
        }
        await persist();
      });
    },
    async markSubmitted(sku, { accepted, message, submittedPrice, jobId, at }) {
      return exclusive(async () => {
        await load();
        const key = canonicalKey(sku);
        if (!key) return null;
        const record = bySku.get(key);
        record.lastJobId = jobId || record.lastJobId;
        if (accepted) {
          record.updateStatus = 'Unverified';
          record.errorMessage = '';
          record.lastSubmittedPrice = submittedPrice;
        } else {
          record.updateStatus = 'Failed';
          record.errorMessage = message || 'Walmart rejected the price update.';
        }
        await persist();
        return toPublicRow({ ...record, markedAt: at });
      });
    },
    async markVerified(sku, { price, currency, matched, message, at }) {
      return exclusive(async () => {
        await load();
        const key = canonicalKey(sku);
        if (!key) return null;
        const record = bySku.get(key);
        if (price != null) {
          record.walmartCurrentPrice = price;
          record.currency = currency || record.currency || 'USD';
          record.lastFetchedAt = at;
        }
        if (matched) {
          record.updateStatus = 'Success';
          record.lastUpdatedAt = at;
          record.errorMessage = '';
        } else {
          record.updateStatus = 'Unverified';
          record.errorMessage = message || 'Walmart accepted the update, but the catalog price does not match yet.';
        }
        await persist();
        return toPublicRow(record);
      });
    },
  };
}
