import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFeedLog } from '../src/store/feedLog.js';
import { refreshOnePriceFeed } from '../src/services/refreshFeedStatus.js';

test('refreshOnePriceFeed checks only the requested feed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-feed-'));
  const feedLog = createFeedLog(dir);
  await feedLog.remember({ feedId: 'FEED-A', feedStatus: 'SUBMITTED' });
  await feedLog.remember({ feedId: 'FEED-B', feedStatus: 'SUBMITTED' });
  const called = [];
  const api = {
    async getPriceFeedStatus(id) {
      called.push(id);
      return {
        feedStatus: 'PROCESSED',
        itemsReceived: 1,
        itemsSucceeded: 1,
        itemsFailed: 0,
        itemsProcessing: 0,
        feedDate: '2026-10-13',
        itemDetails: {
          itemIngestionStatus: [{ sku: 'SKU-1', ingestionStatus: 'SUCCESS' }],
        },
      };
    },
  };
  const store = {
    async applyFeedResults(feedId, items) {
      assert.equal(feedId, 'FEED-A');
      assert.equal(items.length, 1);
      return { matched: 0 };
    },
  };

  const result = await refreshOnePriceFeed({ api, feedLog, store, feedId: 'FEED-A' });

  assert.deepEqual(called, ['FEED-A']);
  assert.equal(result.feed.feedStatus, 'PROCESSED');
  assert.equal(result.feeds.find((feed) => feed.feedId === 'FEED-B').feedStatus, 'SUBMITTED');
});

test('refreshOnePriceFeed rejects a blank feed id', async () => {
  await assert.rejects(
    () => refreshOnePriceFeed({
      api: { async getPriceFeedStatus() { throw new Error('should not call Walmart'); } },
      feedLog: { async saveStatus() {}, async list() { return []; } },
      store: { async applyFeedResults() {} },
      feedId: '  ',
    }),
    /feed id is required/i,
  );
});
