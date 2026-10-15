const TOKEN_KEY = 'wmPriceAdminToken';
const FILTER_KEY = 'wmPriceFilters';
const SELECT_KEY = 'wmPriceSelected';

export function loadFilters() {
  try {
    return {
      prefix: 'all',
      mrCategory: 'any',
      q: '',
      sort: 'sku',
      dir: 'asc',
      page: 1,
      pageSize: 50,
      ...JSON.parse(sessionStorage.getItem(FILTER_KEY) || '{}'),
    };
  } catch {
    return { prefix: 'all', mrCategory: 'any', q: '', sort: 'sku', dir: 'asc', page: 1, pageSize: 50 };
  }
}

export function saveFilters(filters) {
  sessionStorage.setItem(FILTER_KEY, JSON.stringify(filters));
}

export function loadSelection() {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SELECT_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

export function saveSelection(selection) {
  sessionStorage.setItem(SELECT_KEY, JSON.stringify([...selection]));
}

export function adminToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

export function saveAdminToken(value) {
  sessionStorage.setItem(TOKEN_KEY, value || '');
}

function queryString(filters, extra = {}) {
  const params = new URLSearchParams();
  const data = { ...filters, ...extra };
  for (const [key, value] of Object.entries(data)) {
    if (value == null || value === '') continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export async function request(path, { method = 'GET', body, filters, extra } = {}) {
  const qs = filters ? `?${queryString(filters, extra)}` : '';
  const headers = { Accept: 'application/json' };
  const token = adminToken();
  if (token) headers['x-price-admin-token'] = token;
  if (body != null) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${path}${qs}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {
        error: /Cannot POST|Cannot GET/.test(text)
          ? 'The price tool is still running the previous server. Stop it with Ctrl+C, run npm start again, then refresh this page.'
          : text.slice(0, 240),
      };
    }
  }
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function exportUrl(format, filters, extra = {}) {
  return `/api/walmart-prices/export?${queryString(filters, { format, page: '', pageSize: '', ...extra })}`;
}

export const api = {
  meta: () => request('/api/walmart-prices/meta'),
  summary: (filters) => request('/api/walmart-prices/summary', { filters }),
  list: (filters) => request('/api/walmart-prices', { filters }),
  saveProposed: (sku, proposedPrice) =>
    request(`/api/walmart-prices/proposed/${encodeURIComponent(sku)}`, {
      method: 'PUT',
      body: { proposedPrice },
    }),
  adjust: (body) => request('/api/walmart-prices/adjust', { method: 'POST', body }),
  clearProposed: (body) => request('/api/walmart-prices/clear-proposed', { method: 'POST', body }),
  importSheet: (body) => request('/api/walmart-prices/import', { method: 'POST', body }),
  preview: (body) => request('/api/walmart-prices/preview-update', { method: 'POST', body }),
  fetchPrices: () => request('/api/walmart-prices/fetch', { method: 'POST', body: {} }),
  fetchInventory: () => request('/api/walmart-prices/inventory', { method: 'POST', body: {} }),
  update: (body) => request('/api/walmart-prices/update', { method: 'POST', body }),
  job: (id) => request(`/api/walmart-prices/jobs/${encodeURIComponent(id)}`),
  feeds: () => request('/api/walmart-prices/feeds'),
  feed: (feedId) => request(`/api/walmart-prices/feeds/${encodeURIComponent(feedId)}`),
  refreshFeeds: () => request('/api/walmart-prices/feeds/refresh', { method: 'POST', body: {} }),
  refreshFeed: (feedId) => request(`/api/walmart-prices/feeds/${encodeURIComponent(feedId)}/refresh`, { method: 'POST', body: {} }),
};
