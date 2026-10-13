import fs from 'node:fs/promises';
import path from 'node:path';

function safeId(feedId) {
  return String(feedId || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
}

export function createFeedLog(dir) {
  const indexPath = path.join(dir, 'price-feeds.json');

  async function readIndex() {
    try {
      const parsed = JSON.parse(await fs.readFile(indexPath, 'utf8'));
      return Array.isArray(parsed?.feeds) ? parsed.feeds : [];
    } catch {
      return [];
    }
  }

  async function writeIndex(feeds) {
    await fs.mkdir(dir, { recursive: true });
    const ordered = [...feeds].sort((a, b) => String(b.feedDate || b.submittedAt || '').localeCompare(String(a.feedDate || a.submittedAt || '')));
    await fs.writeFile(indexPath, `${JSON.stringify({ feeds: ordered.slice(0, 200) }, null, 2)}\n`);
  }

  return {
    async list() {
      return readIndex();
    },
    async read(feedId) {
      const id = String(feedId || '').trim();
      if (!id) return null;
      try {
        return JSON.parse(await fs.readFile(path.join(dir, `${safeId(id)}.json`), 'utf8'));
      } catch {
        return null;
      }
    },
    async remember(feed) {
      const feedId = String(feed?.feedId || '').trim();
      if (!feedId) return null;
      const feeds = await readIndex();
      const existing = feeds.find((row) => row.feedId === feedId) || { feedId };
      const next = {
        ...existing,
        ...feed,
        feedId,
        skus: feed.skus || existing.skus || [],
      };
      const rest = feeds.filter((row) => row.feedId !== feedId);
      await writeIndex([next, ...rest]);
      return next;
    },
    async saveStatus(feedId, status) {
      const id = String(feedId || '').trim();
      if (!id) return null;
      await fs.mkdir(dir, { recursive: true });
      const saved = {
        feedId: id,
        checkedAt: new Date().toISOString(),
        ...status,
      };
      await fs.writeFile(path.join(dir, `${safeId(id)}.json`), `${JSON.stringify(saved, null, 2)}\n`);
      const feeds = await readIndex();
      const existing = feeds.find((row) => row.feedId === id) || { feedId: id };
      const summary = {
        ...existing,
        feedId: id,
        feedStatus: saved.feedStatus || existing.feedStatus || 'UNKNOWN',
        itemsReceived: saved.itemsReceived ?? existing.itemsReceived ?? 0,
        itemsSucceeded: saved.itemsSucceeded ?? existing.itemsSucceeded ?? 0,
        itemsFailed: saved.itemsFailed ?? existing.itemsFailed ?? 0,
        itemsProcessing: saved.itemsProcessing ?? existing.itemsProcessing ?? 0,
        feedDate: saved.feedDate || existing.feedDate || '',
        checkedAt: saved.checkedAt,
        itemCount: saved.items?.length ?? existing.itemCount ?? existing.skus?.length ?? 0,
      };
      const rest = feeds.filter((row) => row.feedId !== id);
      await writeIndex([summary, ...rest]);
      return summary;
    },
  };
}
