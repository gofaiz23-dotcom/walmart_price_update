/**
 * SKU filters.
 *
 * Prefix and suffix checks are case-insensitive, matching the hub IS- series
 * rule (IS- and -GBA-1 are compared without case). The stored SKU string is
 * still the exact value returned by Walmart.
 *
 * MR category uses the suffix only: the SKU must end with `-01FA` or `-04HE`.
 * The token is not matched when it appears in the middle of the SKU.
 */

export const PREFIXES = ['all', 'mr', 'is', 'exclude'];
export const MR_CATEGORIES = ['any', 'mr', '01FA', '04HE'];
export const SORT_KEYS = ['sku', 'current', 'proposed', 'status', 'fetched', 'inventory'];

export function prefixGroup(sku) {
  const value = String(sku || '').trim();
  if (/^MR-/i.test(value)) return 'mr';
  if (/^IS-/i.test(value)) return 'is';
  return 'other';
}

export function mrSuffix(sku) {
  const value = String(sku || '').trim();
  if (/-01FA$/i.test(value)) return '01FA';
  if (/-04HE$/i.test(value)) return '04HE';
  return '';
}

export function matchesPrefix(sku, prefix) {
  const key = prefix || 'all';
  if (key === 'all') return true;
  const group = prefixGroup(sku);
  if (key === 'mr') return group === 'mr';
  if (key === 'is') return group === 'is';
  if (key === 'exclude') return group === 'other';
  return false;
}

export function matchesMrCategory(sku, category) {
  const key = category || 'any';
  if (key === 'any') return true;
  if (key === 'mr') return prefixGroup(sku) === 'mr';
  if (key === '01FA' || key === '04HE') return mrSuffix(sku) === key;
  return false;
}

export function matchesSearch(sku, q) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return true;
  return String(sku || '').toLowerCase().includes(query);
}

export function matchesFilter(record, filter = {}) {
  const sku = record?.sku || '';
  return (
    matchesSearch(sku, filter.q) &&
    matchesPrefix(sku, filter.prefix) &&
    matchesMrCategory(sku, filter.mrCategory)
  );
}

export function normalizeFilter(input = {}) {
  const prefix = String(input.prefix || 'all').trim();
  const mrCategory = String(input.mrCategory || 'any').trim();
  const sort = String(input.sort || 'sku').trim();
  const dir = String(input.dir || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
  if (!PREFIXES.includes(prefix)) {
    throw new Error(`Unknown prefix filter "${prefix}". Use ${PREFIXES.join(', ')}.`);
  }
  if (!MR_CATEGORIES.includes(mrCategory)) {
    throw new Error(`Unknown MR category "${mrCategory}". Use ${MR_CATEGORIES.join(', ')}.`);
  }
  if (!SORT_KEYS.includes(sort)) {
    throw new Error(`Unknown sort "${sort}". Use ${SORT_KEYS.join(', ')}.`);
  }
  return {
    prefix,
    mrCategory,
    q: String(input.q || '').trim(),
    sort,
    dir,
  };
}

function sortValue(record, sort) {
  if (sort === 'current') return record.walmartCurrentPrice;
  if (sort === 'proposed') return record.proposedPrice;
  if (sort === 'status') return record.updateStatus || '';
  if (sort === 'fetched') return record.lastFetchedAt || '';
  if (sort === 'inventory') return record.inventoryAvailable;
  return record.sku || '';
}

export function compareRecords(a, b, sort, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  const av = sortValue(a, sort);
  const bv = sortValue(b, sort);
  const aMissing = av == null || av === '';
  const bMissing = bv == null || bv === '';
  if (aMissing && bMissing) return a.sku.localeCompare(b.sku);
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (sort === 'current' || sort === 'proposed' || sort === 'inventory') {
    const diff = Number(av) - Number(bv);
    if (diff !== 0) return diff * sign;
  } else {
    const diff = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    if (diff !== 0) return diff * sign;
  }
  return a.sku.localeCompare(b.sku);
}

/** Full-catalog counts for the separate download files. 01FA and 04HE are MR- only. */
export function sheetDownloadCounts(records) {
  const counts = { is: 0, mr: 0, fa: 0, he: 0 };
  for (const record of records) {
    const sku = record?.sku;
    if (matchesPrefix(sku, 'is')) counts.is += 1;
    if (!matchesPrefix(sku, 'mr')) continue;
    counts.mr += 1;
    const suffix = mrSuffix(sku);
    if (suffix === '01FA') counts.fa += 1;
    if (suffix === '04HE') counts.he += 1;
  }
  return counts;
}

export function countFilters(records, filter = {}) {
  const searched = records.filter((record) => matchesSearch(record.sku, filter.q));
  const forPrefix = searched.filter((record) => matchesMrCategory(record.sku, filter.mrCategory));
  const forMr = searched.filter((record) => matchesPrefix(record.sku, filter.prefix));
  return {
    all: forPrefix.length,
    mr: forPrefix.filter((record) => matchesPrefix(record.sku, 'mr')).length,
    is: forPrefix.filter((record) => matchesPrefix(record.sku, 'is')).length,
    exclude: forPrefix.filter((record) => matchesPrefix(record.sku, 'exclude')).length,
    mrAny: forMr.length,
    mrAll: forMr.filter((record) => matchesMrCategory(record.sku, 'mr')).length,
    fa: forMr.filter((record) => matchesMrCategory(record.sku, '01FA')).length,
    he: forMr.filter((record) => matchesMrCategory(record.sku, '04HE')).length,
  };
}
