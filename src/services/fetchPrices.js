import { FAILED_STATUSES, READY_STATUSES, extractRequestId, extractRequestStatus } from '../walmart/parse.js';
import { WalmartAuthError, WalmartHttpError } from '../walmart/http.js';
import { sanitizeError } from '../validation/prices.js';

export class ReportUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReportUnavailableError';
  }
}

async function pullItemReport(api, jobManager, job, { pollMs, timeoutMs, sleep, checkpoint, resume }) {
  let requestId = resume && checkpoint?.requestId ? checkpoint.requestId : '';
  if (!requestId) {
    await jobManager.update(job, { phase: 'report', message: 'Requesting Walmart ITEM price report.' });
    const created = await api.createItemReport();
    requestId = created.requestId;
    await jobManager.writeCheckpoint({ requestId, createdAt: new Date().toISOString() });
  }
  await jobManager.update(job, {
    phase: 'report',
    requestId,
    message: `Waiting for Walmart ITEM report ${requestId}.`,
  });

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let status = '';
    let matched = null;
    try {
      const listed = await api.listItemReports();
      matched = listed.find((row) => extractRequestId(row) === requestId) || null;
      status = matched ? extractRequestStatus(matched) : '';
    } catch (err) {
      if (err instanceof WalmartAuthError) throw err;
      status = '';
    }
    if (FAILED_STATUSES.has(status)) {
      throw new ReportUnavailableError(`Walmart ITEM report failed (${status}).`);
    }
    if (READY_STATUSES.has(status)) {
      await jobManager.update(job, { phase: 'download', message: 'Downloading Walmart ITEM report.' });
      const buffer = await api.downloadReadyReport(requestId);
      const rows = await api.parseReportBuffer(buffer);
      await jobManager.clearCheckpoint();
      return rows;
    }
    const reportMessage = `Walmart ITEM report ${requestId} is ${status || 'INPROGRESS'}.`;
    console.log(`[fetch ${job.id}] waiting — ${reportMessage}`);
    await jobManager.update(job, {
      phase: 'report',
      message: reportMessage,
    });
    await sleep(pollMs);
  }
  throw new ReportUnavailableError(`Walmart ITEM report ${requestId} was not ready before the timeout.`);
}

export async function runFetchPrices({
  store,
  api,
  jobManager,
  job,
  mode = 'auto',
  pollMs = 20_000,
  timeoutMs = 20 * 60_000,
  pageSize = 200,
  pageDelayMs = 400,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  resume = true,
}) {
  const fetchedAt = new Date().toISOString();
  let rows = [];
  let source = 'report';
  const checkpoint = await jobManager.readCheckpoint();

  const useItems = async (reason) => {
    source = 'items';
    await jobManager.update(job, {
      phase: 'items',
      source,
      message: reason,
    });
    rows = await api.fetchAllItemPages(
      async (progress) => {
        if (progress.pageRows?.length) {
          await store.applyFetch(progress.pageRows, { fetchedAt, jobId: job.id });
        }
        await jobManager.update(job, {
          phase: 'items',
          source,
          message: progress.message,
          processed: progress.processed,
          total: progress.total || job.total,
          succeeded: progress.processed,
        });
        const totalLabel = progress.total ? ` / ${progress.total}` : '';
        console.log(`[fetch ${job.id}] page saved — ${progress.processed}${totalLabel} products. ${progress.message}`);
      },
      { pageSize, delayMs: pageDelayMs, sleep },
    );
  };

  try {
    if (mode === 'items' || mode === 'auto') {
      await useItems('Fetching products from Walmart one page at a time, with a pause between pages so the rate limit is not hit.');
    } else {
      try {
        rows = await pullItemReport(api, jobManager, job, {
          pollMs,
          timeoutMs,
          sleep,
          checkpoint,
          resume: resume && mode !== 'items',
        });
        source = 'report';
      } catch (err) {
        if (err instanceof WalmartAuthError || mode === 'report') throw err;
        if (err instanceof ReportUnavailableError || (err instanceof WalmartHttpError && (err.status === 403 || err.status === 404))) {
          await useItems(`${sanitizeError(err)} Falling back to paginated item reads.`);
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    await jobManager.log({ jobId: job.id, action: 'fetch', outcome: 'failed', message: err });
    throw err;
  }

  await jobManager.update(job, {
    phase: 'save',
    source,
    total: rows.length,
    message: `Saving ${rows.length} Walmart price rows.`,
  });
  const applied = await store.applyFetch(rows, { fetchedAt, jobId: job.id });
  const succeeded = rows.filter((row) => row.price != null).length;
  const failed = rows.length - succeeded;
  await jobManager.update(job, {
    phase: 'done',
    source,
    total: rows.length,
    processed: rows.length,
    succeeded,
    failed,
    message: `Fetched ${rows.length} products from Walmart. ${succeeded} have a price. ${applied.total} are in the sheet.`,
  });
  await jobManager.log({
    jobId: job.id,
    action: 'fetch',
    outcome: 'completed',
    message: `source=${source} rows=${rows.length} priced=${succeeded}`,
  });
  return { source, ...applied, succeeded, failed, totalRows: rows.length };
}
