import { api } from '../api.js';

const $ = (id) => document.getElementById(id);
const PROCESSING = new Set(['INPROGRESS', 'PROCESSING', 'PENDING']);

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

function failedItem(item) {
  const status = String(item?.ingestionStatus || '').toUpperCase();
  return status !== 'SUCCESS' && !PROCESSING.has(status);
}

function renderItems(items) {
  const ordered = [...items].sort((a, b) => Number(failedItem(b)) - Number(failedItem(a)));
  $('feedItems').innerHTML = ordered.length
    ? ordered.map((item) => {
      const failed = failedItem(item);
      return `<tr class="${failed ? 'feed-failed' : ''}">
        <td class="sku">${escapeHtml(item.sku)}</td>
        <td class="item-status">${escapeHtml(item.ingestionStatus || '')}</td>
        <td class="message">${escapeHtml(item.error || (failed ? 'Walmart rejected this price.' : ''))}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="3">Walmart did not return item details for this feed yet.</td></tr>';
}

const feedId = new URLSearchParams(location.search).get('id') || '';
if (!feedId) {
  $('feedTitle').textContent = 'No feed selected';
  showBanner('Open a feed from the feed status page.', 'bad');
} else {
  $('feedTitle').textContent = feedId;
  try {
    const data = await api.feed(feedId);
    const feed = data.feed || {};
    const items = feed.items || [];
    const failed = items.filter(failedItem);
    $('feedSummary').innerHTML = `${escapeHtml(feed.feedStatus || 'UNKNOWN')} · ${feed.itemsReceived ?? items.length} received · ${feed.itemsSucceeded ?? 0} succeeded · <span class="feed-fail-count">${failed.length} failed</span>`;
    renderItems(failed.length ? failed : items);
    if (failed.length && items.length > failed.length) {
      const rest = document.createElement('p');
      rest.className = 'meta';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = `Show all ${items.length} items`;
      button.addEventListener('click', () => {
        renderItems(items);
        rest.remove();
      });
      rest.append(button);
      $('feedItems').closest('.table-wrap').before(rest);
    }
    if (!failed.length) showBanner('Walmart reported no failed items in this feed.', 'ok');
  } catch (err) {
    showBanner(err.message, 'bad');
  }
}
