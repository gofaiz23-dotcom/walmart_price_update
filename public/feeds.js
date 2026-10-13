import { adminToken, api, saveAdminToken } from './api.js';

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showBanner(text, kind) {
  const banner = $('banner');
  banner.hidden = !text;
  banner.textContent = text || '';
  banner.className = `banner${kind ? ` ${kind}` : ''}`;
}

function renderFeeds(feeds) {
  const rows = feeds || [];
  $('feedRows').innerHTML = rows.length
    ? rows.map((feed) => {
      const when = feed.checkedAt ? new Date(feed.checkedAt).toLocaleString() : 'Not checked yet';
      const failed = Number(feed.itemsFailed || 0);
      const href = `/walmart-prices/feeds/detail.html?id=${encodeURIComponent(feed.feedId)}`;
      return `<tr data-feed="${escapeHtml(feed.feedId)}">
        <td><a href="${href}">${escapeHtml(feed.feedStatus || 'UNKNOWN')}</a></td>
        <td class="feed-id"><a href="${href}">${escapeHtml(feed.feedId)}</a></td>
        <td>${feed.itemsReceived ?? 0}</td>
        <td>${feed.itemsSucceeded ?? 0}</td>
        <td class="${failed ? 'feed-fail-count' : ''}">${failed}</td>
        <td>${feed.itemsProcessing ?? 0}</td>
        <td>${escapeHtml(when)}</td>
        <td class="feed-fetch"><button type="button" class="secondary feed-fetch-btn" data-fetch="${escapeHtml(feed.feedId)}">Fetch</button></td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="8">No feed ids saved yet. Send prices, then fetch a feed.</td></tr>';
  $('feedStatusNote').textContent = rows.length
    ? `${rows.length} feed id${rows.length === 1 ? '' : 's'} saved. Fetch checks one feed with Walmart. Open a row to see the result.`
    : 'No feed ids saved yet.';
}

async function loadFeeds() {
  const data = await api.feeds();
  renderFeeds(data.feeds || []);
}

$('feedRows').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-fetch]');
  if (button) {
    event.preventDefault();
    event.stopPropagation();
    const feedId = button.dataset.fetch;
    button.disabled = true;
    showBanner(`Checking Walmart status for ${feedId}.`);
    try {
      const data = await api.refreshFeed(feedId);
      renderFeeds(data.feeds || []);
      const status = data.feed?.feedStatus || 'saved';
      showBanner(`Saved ${status} for ${feedId}.`, 'ok');
    } catch (err) {
      showBanner(err.message, 'bad');
      button.disabled = false;
    }
    return;
  }
  if (event.target.closest('a')) return;
  const row = event.target.closest('tr[data-feed]');
  if (!row) return;
  location.href = `/walmart-prices/feeds/detail.html?id=${encodeURIComponent(row.dataset.feed)}`;
});

$('adminToken').value = adminToken();
$('adminToken').addEventListener('change', () => saveAdminToken($('adminToken').value.trim()));

const meta = await api.meta();
$('tokenLabel').hidden = !meta.updatesRequireToken;
try {
  await loadFeeds();
} catch (err) {
  showBanner(err.message, 'bad');
}
