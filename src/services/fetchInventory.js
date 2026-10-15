import { sanitizeError } from '../validation/prices.js';

export async function runFetchInventory({
  store,
  api,
  jobManager,
  job,
  pageSize = 50,
  pageDelayMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const fetchedAt = new Date().toISOString();
  const source = 'inventories';
  const pending = [];
  let rows = [];

  async function flush(force = false) {
    if (!pending.length) return;
    if (!force && pending.length < 1000) return;
    const batch = pending.splice(0, pending.length);
    await store.applyInventory(batch, { fetchedAt, jobId: job.id });
  }

  try {
    await jobManager.clearCheckpoint('inventory');
    await jobManager.update(job, {
      phase: 'inventories',
      source,
      message: 'Fetching inventory from Walmart one page at a time.',
    });
    rows = await api.fetchAllInventoryPages(
      async (progress) => {
        if (progress.restart) pending.length = 0;
        if (progress.pageRows?.length) pending.push(...progress.pageRows);
        await jobManager.update(job, {
          phase: 'inventories',
          source,
          message: progress.message,
          processed: progress.processed,
          total: progress.total || job.total,
          succeeded: progress.processed,
        });
        const totalLabel = progress.total ? ` / ${progress.total}` : '';
        console.log(`[inventory ${job.id}] page saved — ${progress.processed}${totalLabel}. ${progress.message}`);
      },
      { pageSize, delayMs: pageDelayMs, sleep },
    );
    await flush(true);
  } catch (err) {
    await flush(true);
    await jobManager.log({ jobId: job.id, action: 'inventory', outcome: 'failed', message: err });
    throw err;
  }

  const withQty = rows.filter((row) => row.available != null).length;
  await jobManager.update(job, {
    phase: 'done',
    source,
    total: rows.length,
    processed: rows.length,
    succeeded: withQty,
    failed: rows.length - withQty,
    message: `Fetched inventory for ${rows.length} products. ${withQty} have a quantity.`,
  });
  await jobManager.log({
    jobId: job.id,
    action: 'inventory',
    outcome: 'completed',
    message: `source=${source} rows=${rows.length} withQty=${withQty}`,
  });
  return { source, totalRows: rows.length, succeeded: withQty };
}
