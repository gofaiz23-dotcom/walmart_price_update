import { feedsFromList, feedItemsFromStatus, isProcessingStatus } from '../walmart/feedStatus.js';

export async function refreshPriceFeedStatus({ api, feedLog, store, limit = 5 }) {
  const saved = await feedLog.list();
  let listed = [];
  let listError = null;
  try {
    listed = await api.listPriceFeeds();
  } catch (err) {
    listError = err;
  }
  for (const feed of listed) {
    await feedLog.remember({
      feedId: feed.feedId,
      feedStatus: feed.feedStatus,
      feedType: feed.feedType,
      itemsReceived: feed.itemsReceived,
      itemsSucceeded: feed.itemsSucceeded,
      itemsFailed: feed.itemsFailed,
      itemsProcessing: feed.itemsProcessing,
      feedDate: feed.feedDate,
    });
  }
  const known = await feedLog.list();
  const detailIds = [];
  const pushId = (feedId) => {
    if (!feedId || detailIds.includes(feedId) || detailIds.length >= limit) return;
    detailIds.push(feedId);
  };
  for (const feed of known) {
    if (feed.feedStatus === 'SUBMITTED' || !feed.checkedAt) pushId(feed.feedId);
  }
  for (const feed of listed) pushId(feed.feedId);
  for (const feed of known) pushId(feed.feedId);
  if (!detailIds.length && listError && !saved.length) throw listError;
  const checked = [];
  for (const feedId of detailIds) {
    const status = await api.getPriceFeedStatus(feedId);
    const items = feedItemsFromStatus(status);
    const saved = await feedLog.saveStatus(feedId, {
      feedStatus: status.feedStatus || 'UNKNOWN',
      itemsReceived: Number(status.itemsReceived ?? items.length),
      itemsSucceeded: Number(status.itemsSucceeded ?? 0),
      itemsFailed: Number(status.itemsFailed ?? 0),
      itemsProcessing: Number(status.itemsProcessing ?? 0),
      feedDate: status.feedDate || '',
      items: items.map((item) => ({
        sku: item.sku,
        ingestionStatus: item.ingestionStatus,
        error: item.error,
      })),
    });
    const applied = await store.applyFeedResults(feedId, items);
    checked.push({ ...saved, applied });
  }
  return { feeds: await feedLog.list(), checked };
}

export async function refreshOnePriceFeed({ api, feedLog, store, feedId }) {
  const id = String(feedId || '').trim();
  if (!id) {
    const err = new Error('A feed id is required.');
    err.statusCode = 400;
    throw err;
  }
  const status = await api.getPriceFeedStatus(id);
  const items = feedItemsFromStatus(status);
  const saved = await feedLog.saveStatus(id, {
    feedStatus: status.feedStatus || 'UNKNOWN',
    itemsReceived: Number(status.itemsReceived ?? items.length),
    itemsSucceeded: Number(status.itemsSucceeded ?? 0),
    itemsFailed: Number(status.itemsFailed ?? 0),
    itemsProcessing: Number(status.itemsProcessing ?? 0),
    feedDate: status.feedDate || '',
    items: items.map((item) => ({
      sku: item.sku,
      ingestionStatus: item.ingestionStatus,
      error: item.error,
    })),
  });
  const applied = await store.applyFeedResults(id, items);
  return { feed: { ...saved, applied }, feeds: await feedLog.list() };
}

export { isProcessingStatus };
