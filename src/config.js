import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_ROOT = path.resolve(SRC_DIR, '..');

const HUB_ENV = path.resolve(TOOL_ROOT, '..', 'marketplacesheet_use_template', '.env');
const LOCAL_ENV = path.join(TOOL_ROOT, '.env');

let envLoaded = false;

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && (process.env[key] == null || process.env[key] === '')) {
      process.env[key] = value;
    }
  }
}

/** Fill missing env vars from the price tool .env, then the hub .env. */
export function ensureEnvLoaded() {
  if (envLoaded) return;
  envLoaded = true;
  parseEnvFile(LOCAL_ENV);
  parseEnvFile(HUB_ENV);
}

export function dataDir() {
  ensureEnvLoaded();
  return process.env.WALMART_PRICE_DATA_DIR?.trim() || path.join(TOOL_ROOT, 'data');
}

export function sheetFilePath() {
  return path.join(dataDir(), 'sheets', 'walmart-price-sheet.json');
}

function apiBaseFromEnv() {
  const explicit = (process.env.WALMART_API_BASE || '').trim().replace(/\/$/, '');
  if (explicit) return explicit;
  const items = (process.env.WALMART_ITEMS_API || '').trim().replace(/\/$/, '');
  if (items) return items.replace(/\/v3\/items$/i, '');
  return 'https://marketplace.walmartapis.com';
}

export function loadRuntimeConfig() {
  ensureEnvLoaded();
  const clientId = (process.env.WALMART_CLIENT_ID || '').trim();
  const clientSecret = (process.env.WALMART_CLIENT_SECRET || '').trim();
  const base = apiBaseFromEnv();
  return {
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
    tokenApi: (process.env.WALMART_TOKEN_API || `${base}/v3/token`).replace(/\/$/, ''),
    apiBase: base,
    channelType: (process.env.WALMART_CHANNEL_TYPE || process.env.WM_CONSUMER_CHANNEL_TYPE || '').trim(),
    svcName: (process.env.WALMART_SVC_NAME || 'Walmart Marketplace').trim(),
    timeoutMs: Number(process.env.WALMART_API_TIMEOUT_MS) || 120_000,
    fetchMode: (process.env.WALMART_PRICE_FETCH_MODE || 'auto').trim().toLowerCase(),
    putDelayMs: Number(process.env.WALMART_PRICE_PUT_DELAY_MS) || 250,
    itemsPageDelayMs: Number(process.env.WALMART_ITEMS_PAGE_DELAY_MS) || 2000,
    itemsPageSize: Math.min(1000, Math.max(1, Number(process.env.WALMART_ITEMS_PAGE_SIZE) || 1000)),
    inventoryPageDelayMs: Number(process.env.WALMART_INVENTORY_PAGE_DELAY_MS) || 500,
    inventoryPageSize: Math.min(50, Math.max(1, Number(process.env.WALMART_INVENTORY_PAGE_SIZE) || 50)),
    reportPollMs: Number(process.env.WALMART_PRICE_REPORT_POLL_MS) || 20_000,
    reportTimeoutMs: Number(process.env.WALMART_PRICE_REPORT_TIMEOUT_MS) || 20 * 60_000,
    verifyAfterUpdate: String(process.env.WALMART_PRICE_VERIFY || 'true').toLowerCase() !== 'false',
    adminToken: (process.env.WALMART_PRICE_ADMIN_TOKEN || '').trim(),
    maxPrice: Number(process.env.WALMART_PRICE_MAX) || 100_000,
  };
}
