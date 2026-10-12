import { isEligible } from '../store/sheetStore.js';
import { matchesFilter, normalizeFilter } from '../filters/skuFilters.js';
import { validateProposedPrice } from '../validation/prices.js';

export function resolveUpdateTargets(records, { scope, skus, filter, maxPrice }) {
  const normalized = normalizeFilter(filter || {});
  const notFound = [];
  let pool = [];

  if (scope === 'selected') {
    const wanted = [...new Set((skus || []).map((sku) => String(sku || '').trim()).filter(Boolean))];
    if (!wanted.length) {
      const error = new Error('Select at least one SKU.');
      error.statusCode = 400;
      throw error;
    }
    const byLower = new Map(records.map((record) => [record.sku.toLowerCase(), record]));
    for (const sku of wanted) {
      const record = byLower.get(sku.toLowerCase());
      if (!record) notFound.push(sku);
      else pool.push(record);
    }
  } else if (scope === 'failed') {
    pool = records.filter((record) => record.updateStatus === 'Failed' && matchesFilter(record, normalized));
  } else if (scope === 'filter') {
    pool = records.filter((record) => matchesFilter(record, normalized) && isEligible(record));
  } else if (scope === 'all') {
    pool = records.filter((record) => isEligible(record));
  } else {
    const error = new Error('Scope must be selected, filter, all, or failed.');
    error.statusCode = 400;
    throw error;
  }

  const targets = [];
  const skipped = [];
  const invalid = [];
  for (const record of pool) {
    const check = validateProposedPrice(record.proposedPrice, { maxPrice });
    if (!check.ok) {
      invalid.push({ sku: record.sku, message: check.message });
      continue;
    }
    if (scope !== 'failed' && !isEligible(record)) {
      skipped.push({ sku: record.sku, message: 'Proposed price matches the current Walmart price.' });
      continue;
    }
    targets.push({ ...record, proposedPrice: check.amount });
  }
  return { targets, skipped, invalid, notFound, scope, filter: normalized };
}
