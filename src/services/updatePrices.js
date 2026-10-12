import { moneyEqual } from '../validation/prices.js';
import { sanitizeError } from '../validation/prices.js';
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
  putDelayMs = 250,
  verify = true,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const records = await store.list();
  const resolved = resolveUpdateTargets(records, { scope, skus, filter, maxPrice });
  const targets = resolved.targets;
  await jobManager.update(job, {
    phase: 'update',
    total: targets.length,
    skipped: resolved.skipped.length + resolved.notFound.length,
    message: `Submitting ${targets.length} price update${targets.length === 1 ? '' : 's'} to Walmart.`,
  });

  let acceptedCount = 0;
  let confirmed = 0;
  let failed = resolved.invalid.length;
  const failures = resolved.invalid.map((item) => ({ sku: item.sku, message: item.message }));
  for (const missing of resolved.notFound) {
    failures.push({ sku: missing, message: 'SKU is not in the price sheet.' });
    failed += 1;
  }

  const accepted = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const currentBefore = target.walmartCurrentPrice;
    try {
      await api.putPrice(target.sku, target.proposedPrice, target.currency || 'USD');
      await store.markSubmitted(target.sku, {
        accepted: true,
        submittedPrice: target.proposedPrice,
        jobId: job.id,
        at: new Date().toISOString(),
      });
      accepted.push(target);
      acceptedCount += 1;
      await jobManager.log({
        jobId: job.id,
        action: 'update',
        sku: target.sku,
        outcome: 'accepted',
        message: 'PUT /v3/price accepted. Current price unchanged until verification.',
      });
    } catch (err) {
      const message = sanitizeError(err);
      failed += 1;
      failures.push({ sku: target.sku, message });
      await store.markSubmitted(target.sku, {
        accepted: false,
        message,
        submittedPrice: target.proposedPrice,
        jobId: job.id,
        at: new Date().toISOString(),
      });
      const after = (await store.list()).find((row) => row.sku.toLowerCase() === target.sku.toLowerCase());
      if (after && after.walmartCurrentPrice !== currentBefore && !(currentBefore == null && after.walmartCurrentPrice == null)) {
        throw new Error(`Refusing to continue: confirmed price for ${target.sku} changed during a failed update.`);
      }
      await jobManager.log({
        jobId: job.id,
        action: 'update',
        sku: target.sku,
        outcome: 'failed',
        message,
      });
    }
    await jobManager.update(job, {
      phase: 'update',
      processed: index + 1,
      succeeded: acceptedCount,
      accepted: acceptedCount,
      failed,
      failures,
      message: `Updated ${index + 1} of ${targets.length}. Accepted ${acceptedCount}, failed ${failed}.`,
    });
    if (putDelayMs && index < targets.length - 1) await sleep(putDelayMs);
  }

  if (verify && accepted.length) {
    await jobManager.update(job, {
      phase: 'verify',
      message: `Checking ${accepted.length} accepted price${accepted.length === 1 ? '' : 's'} on Walmart.`,
    });
    for (let index = 0; index < accepted.length; index += 1) {
      const target = accepted[index];
      const at = new Date().toISOString();
      try {
        const live = await api.getItemPrice(target.sku);
        const matched = live.price != null && moneyEqual(live.price, target.proposedPrice);
        await store.markVerified(target.sku, {
          price: live.price,
          currency: live.currency,
          matched,
          at,
          message: matched
            ? ''
            : 'Walmart accepted the update, but the catalog price does not match yet. Fetch prices again to verify.',
        });
        if (matched) confirmed += 1;
        else {
          await jobManager.log({
            jobId: job.id,
            action: 'verify',
            sku: target.sku,
            outcome: 'unverified',
            message: 'Catalog price does not match the proposed price yet.',
          });
        }
      } catch (err) {
        await store.markVerified(target.sku, {
          price: null,
          matched: false,
          at,
          message: `Walmart accepted the update, but verification failed: ${sanitizeError(err)}`,
        });
        await jobManager.log({
          jobId: job.id,
          action: 'verify',
          sku: target.sku,
          outcome: 'unverified',
          message: err,
        });
      }
      if (putDelayMs && index < accepted.length - 1) await sleep(putDelayMs);
    }
    }

  const status = failed > 0 && acceptedCount === 0 ? 'failed' : 'completed';
  const message = !targets.length
    ? 'No eligible products to update. Set a proposed price that differs from the current Walmart price.'
    : verify
    ? `Walmart confirmed ${confirmed} of ${acceptedCount} accepted price update${acceptedCount === 1 ? '' : 's'}. ${failed} failed. Unmatched catalog prices stay Unverified.`
    : `Walmart accepted ${acceptedCount} update${acceptedCount === 1 ? '' : 's'}. They stay Unverified until a later price fetch matches. ${failed} failed.`;
  await jobManager.update(job, {
    phase: 'done',
    succeeded: verify ? confirmed : acceptedCount,
    accepted: acceptedCount,
    failed,
    failures,
    message,
  });
  return {
    status,
    submitted: acceptedCount,
    confirmed: verify ? confirmed : 0,
    failed,
    skipped: resolved.skipped.length,
  };
}
