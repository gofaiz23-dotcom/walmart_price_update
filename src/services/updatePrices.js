import { sanitizeError } from '../validation/prices.js';
import { chunkPriceUpdates, createPriceFeedWindow } from '../walmart/priceFeed.js';
import { resolveUpdateTargets } from './targets.js';

export async function runPriceUpdates({
  store,
  api,
  jobManager,
  job,
  scope,
  skus,
  filter,
  maxPrice,
  feedWindow,
  feedLog,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const records = await store.list();
  const resolved = resolveUpdateTargets(records, { scope, skus, filter, maxPrice });
  const targets = resolved.targets;
  const chunks = chunkPriceUpdates(targets.map((target) => ({ sku: target.sku, price: target.proposedPrice })));
  const window = feedWindow || createPriceFeedWindow();
  await jobManager.update(job, {
    phase: 'update',
    total: targets.length,
    skipped: resolved.skipped.length + resolved.notFound.length,
    message: targets.length
      ? `Submitting ${targets.length} price${targets.length === 1 ? '' : 's'} in ${chunks.length} Walmart price feed${chunks.length === 1 ? '' : 's'}.`
      : 'No eligible products to update.',
  });

  let acceptedCount = 0;
  let failed = resolved.invalid.length;
  let processed = 0;
  let feedsSent = 0;
  const failures = resolved.invalid.map((item) => ({ sku: item.sku, message: item.message }));
  for (const missing of resolved.notFound) {
    failures.push({ sku: missing, message: 'SKU is not in the price sheet.' });
    failed += 1;
  }

    let stoppedForLimit = false;
    let stoppedOffline = false;
    let offlineMessage = '';
    for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    await window.acquire(sleep, async (waitMs) => {
      const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
      await jobManager.update(job, {
        phase: 'update',
        message: `Walmart allows 10 price feeds per hour. Waiting about ${minutes} minute${minutes === 1 ? '' : 's'} before the next feed.`,
      });
    });
    await window.save?.();
    const at = new Date().toISOString();
    try {
      const result = await api.submitPriceFeed(chunk);
      await store.markSubmittedMany(
        chunk.map((item) => ({ sku: item.sku, accepted: true, submittedPrice: item.price })),
        { jobId: job.id, at, feedId: result.feedId },
      );
      acceptedCount += chunk.length;
      feedsSent += 1;
      await feedLog?.remember({
        feedId: result.feedId,
        feedStatus: 'SUBMITTED',
        itemCount: chunk.length,
        skus: chunk.map((item) => item.sku),
        submittedAt: at,
      });
      await jobManager.log({
        jobId: job.id,
        action: 'update',
        sku: chunk.length === 1 ? chunk[0].sku : '',
        outcome: 'accepted',
        message: `Price feed ${result.feedId} accepted ${chunk.length} product${chunk.length === 1 ? '' : 's'}.`,
      });
    } catch (err) {
      const message = sanitizeError(err);
      if (err?.status === 429 || err?.status === 0) {
        stoppedForLimit = err.status === 429;
        stoppedOffline = err.status === 0;
        offlineMessage = message;
        await jobManager.log({
          jobId: job.id,
          action: 'update',
          outcome: 'failed',
          message,
        });
        break;
      }
      failed += chunk.length;
      for (const item of chunk) failures.push({ sku: item.sku, message });
      await store.markSubmittedMany(
        chunk.map((item) => ({ sku: item.sku, accepted: false, message, submittedPrice: item.price })),
        { jobId: job.id, at },
      );
      const sample = chunk[0];
      const before = targets.find((row) => row.sku === sample.sku)?.walmartCurrentPrice;
      const after = (await store.list()).find((row) => row.sku.toLowerCase() === sample.sku.toLowerCase());
      if (after && after.walmartCurrentPrice !== before && !(before == null && after.walmartCurrentPrice == null)) {
        throw new Error(`Refusing to continue: confirmed price for ${sample.sku} changed during a failed update.`);
      }
      await jobManager.log({
        jobId: job.id,
        action: 'update',
        sku: chunk.length === 1 ? chunk[0].sku : '',
        outcome: 'failed',
        message,
      });
    }
    processed += chunk.length;
    await jobManager.update(job, {
      phase: 'update',
      processed,
      succeeded: acceptedCount,
      accepted: acceptedCount,
      failed,
      failures,
      message: `Sent feed ${index + 1} of ${chunks.length} (${chunk.length} products). Accepted ${acceptedCount}, failed ${failed}.`,
    });
  }

  const status = failed > 0 && acceptedCount === 0 ? 'failed' : 'completed';
  const remaining = targets.length - processed;
  let message = 'No eligible products to update. Set a proposed price that differs from the current Walmart price.';
  if (targets.length) {
    message = `Walmart accepted ${feedsSent} price feed${feedsSent === 1 ? '' : 's'} covering ${acceptedCount} product${acceptedCount === 1 ? '' : 's'}. They stay Unverified until a later price fetch matches. ${failed} failed.`;
    if (stoppedForLimit && remaining > 0) {
      message = `Walmart’s hourly price-feed limit stopped the run. ${acceptedCount} products were submitted. ${remaining} are still pending. ${failed} failed.`;
    }
    if (stoppedOffline) {
      message = `Could not reach Walmart (${offlineMessage}). Nothing was accepted. The proposed prices are still in the table.`;
    }
  }
  await jobManager.update(job, {
    phase: 'done',
    succeeded: acceptedCount,
    accepted: acceptedCount,
    failed,
    failures,
    message,
  });
  return {
    status,
    submitted: acceptedCount,
    confirmed: 0,
    failed,
    skipped: resolved.skipped.length,
    feeds: feedsSent,
  };
}
