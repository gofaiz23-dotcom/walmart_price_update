/** Read Walmart price-feed list and status payloads. */

const PROCESSING = new Set(['INPROGRESS', 'PROCESSING', 'PENDING']);

export function feedsFromList(body) {
  const raw = body?.results?.feed || body?.list?.feed || body?.feeds || body?.feed || [];
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return rows
    .map((feed) => ({
      feedId: String(feed?.feedId || feed?.feedID || '').trim(),
      feedStatus: String(feed?.feedStatus || 'UNKNOWN'),
      feedType: String(feed?.feedType || feed?.feedtype || ''),
      itemsReceived: Number(feed?.itemsReceived ?? 0),
      itemsSucceeded: Number(feed?.itemsSucceeded ?? 0),
      itemsFailed: Number(feed?.itemsFailed ?? 0),
      itemsProcessing: Number(feed?.itemsProcessing ?? 0),
      feedDate: feed?.feedDate || feed?.createdDate || '',
    }))
    .filter((feed) => feed.feedId);
}

export function feedItemsFromStatus(body) {
  const raw = body?.itemDetails?.itemIngestionStatus || [];
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return rows.map((item) => {
    const errors = item?.ingestionErrors?.ingestionError || [];
    const list = Array.isArray(errors) ? errors : errors ? [errors] : [];
    const description = list.map((err) => err?.description || err?.info || err?.code).filter(Boolean).join('; ');
    return {
      sku: String(item?.sku || '').trim(),
      ingestionStatus: String(item?.ingestionStatus || 'UNKNOWN').toUpperCase(),
      error: description,
    };
  }).filter((item) => item.sku);
}

export function isProcessingStatus(status) {
  return PROCESSING.has(String(status || '').toUpperCase());
}

export function feedStatusPath(feedId, { offset = 0, limit = 1000 } = {}) {
  const params = new URLSearchParams({
    includeDetails: 'true',
    limit: String(Math.min(1000, Math.max(1, Number(limit) || 1000))),
    offset: String(Math.max(0, Number(offset) || 0)),
  });
  return `/v3/feeds/${encodeURIComponent(feedId)}?${params}`;
}
