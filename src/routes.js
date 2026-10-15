import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { dataDir, loadRuntimeConfig, sheetFilePath } from './config.js';
import { getJobManager } from './jobs/jobManager.js';
import { createSheetStore } from './store/sheetStore.js';
import { exportFileName, exportScope, toCsv, toSampleXlsxBuffer, toXlsxBuffer } from './store/exportSheet.js';
import { priceRowsFromBuffer } from './store/importSheet.js';
import { createWalmartClient } from './walmart/http.js';
import { createPriceApi } from './walmart/priceApi.js';
import { createInventoryApi } from './walmart/inventoryApi.js';
import { openPriceFeedWindow } from './walmart/priceFeed.js';
import { createFeedLog } from './store/feedLog.js';
import { refreshOnePriceFeed, refreshPriceFeedStatus } from './services/refreshFeedStatus.js';
import { runFetchPrices } from './services/fetchPrices.js';
import { runFetchInventory } from './services/fetchInventory.js';
import { runPriceUpdates } from './services/updatePrices.js';
import { resolveUpdateTargets } from './services/targets.js';
import { sanitizeError } from './validation/prices.js';

const stores = new Map();

export function getSheetStore() {
  const file = sheetFilePath();
  if (!stores.has(file)) stores.set(file, createSheetStore(file));
  return stores.get(file);
}

function tokensMatch(sent, expected) {
  const a = Buffer.from(String(sent || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  const { adminToken } = loadRuntimeConfig();
  if (!adminToken) return next();
  if (!tokensMatch(req.get('x-price-admin-token'), adminToken)) {
    return res.status(401).json({ error: 'Unauthorized. A price admin token is required for this action.' });
  }
  return next();
}

function sendError(res, err) {
  const status = err.statusCode || (err.code === 'AUTH' ? 401 : 500);
  res.status(status).json({ error: sanitizeError(err) });
}

function filterFrom(input = {}) {
  return {
    prefix: input.prefix,
    mrCategory: input.mrCategory,
    q: input.q,
    sort: input.sort,
    dir: input.dir,
    page: input.page,
    pageSize: input.pageSize,
  };
}

function scopeText(scope) {
  if (scope === 'selected') return 'selected products only';
  if (scope === 'filter') return 'eligible products in the current filter, including other pages';
  if (scope === 'all') return 'all eligible products in the entire price sheet';
  if (scope === 'failed') return 'failed products in the current filter';
  return scope;
}

let staleChecked = false;

export function mountWalmartPriceRoutes(app) {
  app.get('/api/walmart-prices/meta', (_req, res) => {
    const config = loadRuntimeConfig();
    res.json({
      credentialsConfigured: config.configured,
      updatesRequireToken: Boolean(config.adminToken),
      fetchMode: config.fetchMode,
      verifyAfterUpdate: config.verifyAfterUpdate,
    });
  });

  app.get('/api/walmart-prices/summary', async (req, res) => {
    try {
      if (!staleChecked) {
        staleChecked = true;
        await getJobManager().interruptStale();
      }
      const summary = await getSheetStore().summary(filterFrom(req.query));
      res.json({ ...summary, activeJob: getJobManager().activeJob() });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/walmart-prices', async (req, res) => {
    try {
      res.json(await getSheetStore().query(filterFrom(req.query)));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/walmart-prices/export', async (req, res) => {
    try {
      const format = String(req.query.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
      const filter = filterFrom(req.query);
      const rows = await getSheetStore().filtered(filter);
      const sample = String(req.query.sample || '') === '1';
      const filename = exportFileName(sample ? 'xlsx' : format, sample ? `sample-${exportScope(filter)}` : exportScope(filter));
      if (sample) {
        const buffer = await toSampleXlsxBuffer(rows);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
        return;
      }
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(toCsv(rows));
        return;
      }
      const buffer = await toXlsxBuffer(rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.put('/api/walmart-prices/proposed/:sku', async (req, res) => {
    try {
      const row = await getSheetStore().setProposed(req.params.sku, req.body?.proposedPrice, {
        maxPrice: loadRuntimeConfig().maxPrice,
      });
      res.json({ row });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/walmart-prices/import', async (req, res) => {
    try {
      const body = req.body || {};
      const encoded = String(body.fileBase64 || '').trim();
      if (!encoded) {
        return res.status(400).json({ error: 'Choose a CSV or Excel sheet to upload.' });
      }
      const buffer = Buffer.from(encoded, 'base64');
      const updates = await priceRowsFromBuffer(buffer, body.filename || '');
      const result = await getSheetStore().applyImportedPrices(updates, {
        maxPrice: loadRuntimeConfig().maxPrice,
      });
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/walmart-prices/clear-proposed', async (req, res) => {
    try {
      const result = await getSheetStore().clearProposed(filterFrom(req.body?.filter || {}));
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/walmart-prices/adjust', async (req, res) => {
    try {
      const body = req.body || {};
      const result = await getSheetStore().adjustByPercent(filterFrom(body.filter || {}), body.percent, {
        maxPrice: loadRuntimeConfig().maxPrice,
      });
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/walmart-prices/proposed', async (req, res) => {
    try {
      const result = await getSheetStore().setProposedMany(req.body?.updates || [], {
        maxPrice: loadRuntimeConfig().maxPrice,
      });
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/walmart-prices/preview-update', async (req, res) => {
    try {
      const body = req.body || {};
      const records = await getSheetStore().list();
      const resolved = resolveUpdateTargets(records, {
        scope: body.scope,
        skus: body.skus,
        filter: body.filter || {},
        maxPrice: loadRuntimeConfig().maxPrice,
      });
      res.json({
        scope: resolved.scope,
        scopeText: scopeText(resolved.scope),
        count: resolved.targets.length,
        skipped: resolved.skipped.length,
        invalid: resolved.invalid,
        notFound: resolved.notFound,
        sample: resolved.targets.slice(0, 20).map((row) => ({
          sku: row.sku,
          walmartCurrentPrice: row.walmartCurrentPrice,
          proposedPrice: row.proposedPrice,
          priceDifference:
            row.walmartCurrentPrice == null ? null : Math.round((row.proposedPrice - row.walmartCurrentPrice) * 100) / 100,
        })),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/walmart-prices/jobs/active', (_req, res) => {
    res.json({ job: getJobManager().activeJob() });
  });

  app.get('/api/walmart-prices/feeds', async (_req, res) => {
    const feeds = await createFeedLog(path.join(dataDir(), 'feeds')).list();
    res.json({ feeds });
  });

  app.get('/api/walmart-prices/feeds/:feedId', async (req, res) => {
    const feed = await createFeedLog(path.join(dataDir(), 'feeds')).read(req.params.feedId);
    if (!feed) return res.status(404).json({ error: 'That feed id is not saved yet.' });
    return res.json({ feed });
  });

  app.post('/api/walmart-prices/feeds/:feedId/refresh', requireAdmin, async (req, res) => {
    try {
      const config = loadRuntimeConfig();
      if (!config.configured) {
        return res.status(400).json({
          error: 'Walmart credentials are not configured. Set WALMART_CLIENT_ID and WALMART_CLIENT_SECRET in the hub .env.',
        });
      }
      const result = await refreshOnePriceFeed({
        api: createPriceApi(createWalmartClient()),
        feedLog: createFeedLog(path.join(dataDir(), 'feeds')),
        store: getSheetStore(),
        feedId: req.params.feedId,
      });
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.post('/api/walmart-prices/feeds/refresh', requireAdmin, async (_req, res) => {
    try {
      const config = loadRuntimeConfig();
      if (!config.configured) {
        return res.status(400).json({
          error: 'Walmart credentials are not configured. Set WALMART_CLIENT_ID and WALMART_CLIENT_SECRET in the hub .env.',
        });
      }
      const result = await refreshPriceFeedStatus({
        api: createPriceApi(createWalmartClient()),
        feedLog: createFeedLog(path.join(dataDir(), 'feeds')),
        store: getSheetStore(),
      });
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.get('/api/walmart-prices/jobs/:id', async (req, res) => {
    const job = await getJobManager().get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    return res.json({ job });
  });

  app.post('/api/walmart-prices/fetch', requireAdmin, async (req, res) => {
    try {
      const config = loadRuntimeConfig();
      if (!config.configured) {
        return res.status(400).json({
          error: 'Walmart credentials are not configured. Set WALMART_CLIENT_ID and WALMART_CLIENT_SECRET in the hub .env.',
        });
      }
      const jobs = getJobManager();
      const job = await jobs.start({ type: 'fetch', message: 'Starting Walmart price fetch.' });
      console.log(`[fetch ${job.id}] started — reading products from Walmart`);
      res.status(202).json({ job: await jobs.get(job.id) });
      const api = createPriceApi(createWalmartClient());
      runFetchPrices({
        store: getSheetStore(),
        api,
        jobManager: jobs,
        job,
        mode: config.fetchMode,
        pollMs: config.reportPollMs,
        timeoutMs: config.reportTimeoutMs,
        pageSize: config.itemsPageSize,
        pageDelayMs: config.itemsPageDelayMs,
        resume: req.body?.fresh !== true,
      })
        .then(async () => {
          console.log(`[fetch ${job.id}] finished — ${job.message}`);
          await jobs.finish(job, { status: 'completed', message: job.message });
        })
        .catch(async (err) => {
          console.log(`[fetch ${job.id}] failed — ${sanitizeError(err)}`);
          await jobs.log({ jobId: job.id, action: 'fetch', outcome: 'failed', message: err });
          await jobs.finish(job, { status: 'failed', message: sanitizeError(err) });
        });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/walmart-prices/inventory', requireAdmin, async (req, res) => {
    try {
      const config = loadRuntimeConfig();
      if (!config.configured) {
        return res.status(400).json({
          error: 'Walmart credentials are not configured. Set WALMART_CLIENT_ID and WALMART_CLIENT_SECRET in the hub .env.',
        });
      }
      const jobs = getJobManager();
      const job = await jobs.start({ type: 'inventory', message: 'Starting Walmart inventory fetch.' });
      console.log(`[inventory ${job.id}] started — reading inventory from Walmart`);
      res.status(202).json({ job: await jobs.get(job.id) });
      const client = createWalmartClient();
      const priceApi = createPriceApi(client);
      const api = createInventoryApi(client, {
        downloadReadyReport: (requestId) => priceApi.downloadReadyReport(requestId),
      });
      runFetchInventory({
        store: getSheetStore(),
        api,
        jobManager: jobs,
        job,
        pollMs: config.reportPollMs,
        timeoutMs: config.reportTimeoutMs,
        pageSize: config.inventoryPageSize,
        pageDelayMs: config.inventoryPageDelayMs,
        resume: req.body?.fresh !== true,
      })
        .then(async () => {
          console.log(`[inventory ${job.id}] finished — ${job.message}`);
          await jobs.finish(job, { status: 'completed', message: job.message });
        })
        .catch(async (err) => {
          console.log(`[inventory ${job.id}] failed — ${sanitizeError(err)}`);
          await jobs.log({ jobId: job.id, action: 'inventory', outcome: 'failed', message: err });
          await jobs.finish(job, { status: 'failed', message: sanitizeError(err) });
        });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/walmart-prices/update', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      if (body.confirm !== true) {
        return res.status(400).json({ error: 'Confirmation is required before prices are sent to Walmart.' });
      }
      const config = loadRuntimeConfig();
      if (!config.configured) {
        return res.status(400).json({
          error: 'Walmart credentials are not configured. Set WALMART_CLIENT_ID and WALMART_CLIENT_SECRET in the hub .env.',
        });
      }
      const jobs = getJobManager();
      const job = await jobs.start({
        type: 'update',
        message: `Preparing Walmart price update (${scopeText(body.scope)}).`,
      });
      res.status(202).json({ job: await jobs.get(job.id) });
      const api = createPriceApi(createWalmartClient());
      const feedWindow = await openPriceFeedWindow(path.join(dataDir(), 'jobs', 'price-feed-calls.json'));
      runPriceUpdates({
        store: getSheetStore(),
        api,
        jobManager: jobs,
        job,
        scope: body.scope,
        skus: body.skus,
        filter: body.filter || {},
        maxPrice: config.maxPrice,
        feedWindow,
        feedLog: createFeedLog(path.join(dataDir(), 'feeds')),
      })
        .then(async (result) => {
          await jobs.finish(job, { status: result.status, message: job.message });
        })
        .catch(async (err) => {
          await jobs.log({ jobId: job.id, action: 'update', outcome: 'failed', message: err });
          await jobs.finish(job, { status: 'failed', message: sanitizeError(err) });
        });
    } catch (err) {
      sendError(res, err);
    }
  });
}

export { dataDir };
