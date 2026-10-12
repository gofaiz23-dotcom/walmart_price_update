import { randomUUID } from 'node:crypto';
import { loadRuntimeConfig } from '../config.js';
import { sanitizeError } from '../validation/prices.js';

export class WalmartAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WalmartAuthError';
    this.code = 'AUTH';
  }
}

export class WalmartHttpError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'WalmartHttpError';
    this.status = status;
    this.retryable = retryable;
  }
}

function correlationId(prefix) {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function parseTokenBody(text, contentType) {
  const raw = String(text || '');
  if (contentType.includes('xml') || raw.trim().startsWith('<')) {
    const match = raw.match(/<(?:access_token|AccessToken)>([^<]+)<\/(?:access_token|AccessToken)>/i);
    const exp = raw.match(/<(?:expires_in|ExpiresIn)>([^<]+)<\/(?:expires_in|ExpiresIn)>/i);
    return {
      accessToken: match?.[1]?.trim() || '',
      expiresIn: Number(exp?.[1]) || 900,
    };
  }
  const data = raw ? JSON.parse(raw) : {};
  return {
    accessToken: data.access_token || data.accessToken || data.token || '',
    expiresIn: Number(data.expires_in || data.expiresIn) || 900,
  };
}

export function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

export function createWalmartClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getConfig = options.getConfig || loadRuntimeConfig;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let cachedToken = '';
  let tokenExpiresAt = 0;

  async function fetchToken(config) {
    if (!config.configured) {
      throw new WalmartAuthError('Walmart credentials are not configured. Set WALMART_CLIENT_ID and WALMART_CLIENT_SECRET in the hub .env.');
    }
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const response = await fetchImpl(config.tokenApi, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'WM_SVC.NAME': config.svcName,
        'WM_QOS.CORRELATION_ID': correlationId('walmart-token'),
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new WalmartAuthError(`Walmart token request failed (${response.status}).`);
    }
    const parsed = parseTokenBody(text, response.headers.get('content-type') || '');
    if (!parsed.accessToken) {
      throw new WalmartAuthError('Walmart token response did not include an access token.');
    }
    cachedToken = parsed.accessToken;
    tokenExpiresAt = Date.now() + parsed.expiresIn * 1000;
    return cachedToken;
  }

  async function getToken(force = false) {
    const config = getConfig();
    if (!force && cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
    return fetchToken(config);
  }

  function clearToken() {
    cachedToken = '';
    tokenExpiresAt = 0;
  }

  async function request(spec) {
    const config = getConfig();
    const maxAttempts = spec.maxAttempts ?? 4;
    let authRetried = false;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const walmartAuthed = spec.auth !== false;
      const token = walmartAuthed ? await getToken(authRetried) : '';
      const headers = {
        Accept: spec.accept || (walmartAuthed ? 'application/json' : '*/*'),
        ...(walmartAuthed
          ? {
              'WM_SVC.NAME': config.svcName,
              'WM_QOS.CORRELATION_ID': correlationId(spec.prefix || 'walmart'),
              'WM_SEC.ACCESS_TOKEN': token,
              ...(config.channelType ? { 'WM_CONSUMER.CHANNEL.TYPE': config.channelType } : {}),
            }
          : {}),
        ...(spec.headers || {}),
      };
      if (spec.json != null) {
        headers['Content-Type'] = 'application/json';
      }
      const url = spec.url || `${config.apiBase}${spec.path}`;
      let response;
      try {
        response = await fetchImpl(url, {
          method: spec.method || 'GET',
          headers,
          body: spec.json != null ? JSON.stringify(spec.json) : spec.body,
          signal: AbortSignal.timeout(spec.timeoutMs || config.timeoutMs),
        });
      } catch (err) {
        lastError = new WalmartHttpError(sanitizeError(err), { status: 0, retryable: true });
        if (attempt < maxAttempts) {
          await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
          continue;
        }
        throw lastError;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || '';
      if (response.status === 401 && spec.auth !== false && !authRetried) {
        clearToken();
        authRetried = true;
        continue;
      }
      if (response.status === 401 && spec.auth !== false) {
        throw new WalmartAuthError('Walmart rejected the access token.');
      }
      if (!response.ok) {
        const snippet = buffer.toString('utf8').slice(0, 300);
        const retryable = isRetryableStatus(response.status);
        lastError = new WalmartHttpError(`Walmart ${spec.method || 'GET'} failed (${response.status}). ${snippet}`.trim(), {
          status: response.status,
          retryable,
        });
        if (retryable && attempt < maxAttempts) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const wait = response.status === 429
            ? Math.min(180_000, Math.max(20_000, (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 20_000 * attempt)))
            : Math.min(30_000, 1000 * 2 ** (attempt - 1));
          await sleep(wait);
          continue;
        }
        throw lastError;
      }

      if (spec.raw) return { status: response.status, buffer, contentType };
      const text = buffer.toString('utf8');
      let body = null;
      if (text && (contentType.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('['))) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text.slice(0, 500) };
        }
      } else if (text) {
        body = { raw: text.slice(0, 500) };
      }
      return { status: response.status, body, buffer, contentType };
    }
    throw lastError || new WalmartHttpError('Walmart request failed.', { retryable: true });
  }

  return { request, getToken, clearToken, getConfig };
}
