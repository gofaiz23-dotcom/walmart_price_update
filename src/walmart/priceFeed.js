import fs from 'node:fs/promises';
import path from 'node:path';

/** Walmart bulk price feed. One call is used for a single product and for many. */
export const PRICE_FEED_PATH = '/v3/feeds?feedType=PRICE_AND_PROMOTION';
export const PRICE_FEED_HARD_CAP = 10_000;
export const PRICE_FEED_RECOMMENDED_ITEMS = 1_000;
export const PRICE_FEED_MAX_BYTES = 10 * 1024 * 1024;
export const PRICE_FEED_CALLS_PER_HOUR = 10;
export const PRICE_FEED_WINDOW_MS = 60 * 60 * 1000;

const FEED_HEADER = {
  businessUnit: 'WALMART_US',
  version: '2.0.20240126-12_25_52-api',
  locale: 'en',
};

export function priceFeedBody(items) {
  return {
    MPItemFeedHeader: FEED_HEADER,
    MPItem: (items || []).map((item) => ({
      'Promo&Discount': {
        sku: String(item.sku || '').trim(),
        price: Number(item.price),
      },
    })),
  };
}

export function chunkPriceUpdates(items, { maxItems = PRICE_FEED_RECOMMENDED_ITEMS, maxBytes = PRICE_FEED_MAX_BYTES } = {}) {
  const limit = Math.min(PRICE_FEED_HARD_CAP, Math.max(1, Number(maxItems) || PRICE_FEED_RECOMMENDED_ITEMS));
  const chunks = [];
  let current = [];
  for (const item of items || []) {
    if (!current.length) {
      current = [item];
      continue;
    }
    const next = current.concat(item);
    const tooMany = next.length > limit;
    const tooBig = Buffer.byteLength(JSON.stringify(priceFeedBody(next))) > maxBytes;
    if (tooMany || tooBig) {
      chunks.push(current);
      current = [item];
    } else {
      current = next;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function createPriceFeedWindow({
  callsPerHour = PRICE_FEED_CALLS_PER_HOUR,
  windowMs = PRICE_FEED_WINDOW_MS,
  now = () => Date.now(),
  stamps = [],
} = {}) {
  const times = stamps.map(Number).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  function prune(at) {
    const cutoff = at - windowMs;
    while (times.length && times[0] <= cutoff) times.shift();
  }
  return {
    times,
    async acquire(sleep, onWait) {
      const at = now();
      prune(at);
      if (times.length < callsPerHour) {
        times.push(at);
        return 0;
      }
      const waitMs = Math.max(0, times[0] + windowMs - at);
      if (waitMs > 0 && onWait) await onWait(waitMs);
      if (waitMs > 0) await sleep(waitMs);
      return waitMs + (await this.acquire(sleep, onWait));
    },
  };
}

export async function openPriceFeedWindow(filePath, options = {}) {
  let stamps = [];
  try {
    const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (Array.isArray(saved?.stamps)) stamps = saved.stamps;
  } catch {
    stamps = [];
  }
  const window = createPriceFeedWindow({ ...options, stamps });
  window.save = async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ stamps: window.times }));
  };
  return window;
}
