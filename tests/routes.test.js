import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

test('list, save, and export do not call Walmart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-routes-'));
  process.env.WALMART_PRICE_DATA_DIR = dir;
  process.env.WALMART_PRICE_ADMIN_TOKEN = 'secret-token';
  const { mountWalmartPriceRoutes } = await import(`../src/routes.js?test=${dir}`);
  const app = express();
  app.use(express.json());
  mountWalmartPriceRoutes(app);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const summary = await fetch(`${base}/api/walmart-prices/summary`);
    assert.equal(summary.status, 200);
    const body = await summary.json();
    assert.equal(body.total, 0);

    const saved = await fetch(`${base}/api/walmart-prices/proposed/${encodeURIComponent('MR-1-01FA')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposedPrice: 15.5 }),
    });
    assert.equal(saved.status, 200);

    const blocked = await fetch(`${base}/api/walmart-prices/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'all', confirm: true }),
    });
    assert.equal(blocked.status, 401);

    const csv = await fetch(`${base}/api/walmart-prices/export?format=csv&prefix=mr&mrCategory=01FA`);
    const text = await csv.text();
    assert.match(text, /MR-1-01FA,,15\.5/);
    assert.match(text, /Walmart Current Price/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
