import { adminToken, api, exportUrl, loadFilters, loadSelection, saveAdminToken, saveFilters, saveSelection } from './api.js';

const $ = (id) => document.getElementById(id);
const state = {
  filters: loadFilters(),
  selection: loadSelection(),
  rows: [],
  summary: null,
  job: null,
  polling: false,
  busy: false,
  editSku: '',
};

function money(value) {
  if (value == null || value === '') return '—';
  return Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function diffText(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  const text = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  if (n > 0) return `+${text}`;
  if (n < 0) return `−${text}`;
  return text;
}

function differenceLabel(current, proposed) {
  if (proposed == null || proposed === '' || current == null || current === '') return '—';
  const base = Number(current);
  const next = Number(proposed);
  if (!Number.isFinite(base) || !Number.isFinite(next)) return '—';
  const cents = Math.round((next - base) * 100);
  if (cents === 0) return 'same';
  const dollars = diffText(cents / 100);
  if (!base) return dollars;
  const pct = Math.round((cents / Math.round(base * 100)) * 1000) / 10;
  const abs = Math.abs(pct);
  const body = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
  const sign = pct > 0 ? '+' : '−';
  return `${dollars} · ${sign}${body}%`;
}

function when(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function showBanner(text, kind) {
  const banner = $('banner');
  banner.hidden = !text;
  banner.textContent = text || '';
  banner.className = `banner${kind ? ` ${kind}` : ''}`;
}

function currentFilterBody() {
  return {
    prefix: state.filters.prefix,
    mrCategory: state.filters.mrCategory,
    q: state.filters.q,
    sort: state.filters.sort,
    dir: state.filters.dir,
  };
}

function activeDownloadSpec() {
  const prefix = state.filters.prefix;
  const mr = state.filters.mrCategory;
  if (prefix === 'is') return { prefix: 'is', mrCategory: 'any', file: 'IS', label: 'IS-' };
  if (prefix === 'mr' && mr === '01FA') return { prefix: 'mr', mrCategory: '01FA', file: 'MR-01FA', label: 'MR-01FA' };
  if (prefix === 'mr' && mr === '04HE') return { prefix: 'mr', mrCategory: '04HE', file: 'MR-04HE', label: 'MR-04HE' };
  if (prefix === 'mr') return { prefix: 'mr', mrCategory: 'any', file: 'MR', label: 'MR-' };
  if (prefix === 'exclude') return { prefix: 'exclude', mrCategory: 'any', file: 'other', label: 'Other' };
  return { prefix: 'all', mrCategory: 'any', file: 'all', label: 'All' };
}

function countForSpec(spec) {
  const sheets = state.sheetCounts;
  const total = state.summary?.total || 0;
  if (spec.file === 'all') return total;
  if (!sheets) return null;
  if (spec.file === 'IS') return sheets.is;
  if (spec.file === 'MR') return sheets.mr;
  if (spec.file === 'MR-01FA') return sheets.fa;
  if (spec.file === 'MR-04HE') return sheets.he;
  if (spec.file === 'other') return Math.max(0, total - sheets.is - sheets.mr);
  return null;
}

function noteSheetCounts(summary, { full = false } = {}) {
  if (summary?.sheets) {
    state.sheetCounts = summary.sheets;
    return;
  }
  const openCatalog = full || (state.filters.prefix === 'all' && state.filters.mrCategory === 'any' && !state.filters.q);
  if (!openCatalog || !summary?.counts) return;
  state.sheetCounts = {
    is: summary.counts.is || 0,
    mr: summary.counts.mr || 0,
    fa: summary.counts.fa || 0,
    he: summary.counts.he || 0,
  };
}

function renderDownloads() {
  const spec = activeDownloadSpec();
  const count = countForSpec(spec);
  const scope = $('downloadScope');
  if (scope) {
    scope.textContent = Number.isFinite(count) ? `${spec.label} · ${Number(count).toLocaleString()}` : spec.label;
  }
  const disabled = state.busy || state.downloading || count === 0;
  if ($('btnXlsx')) $('btnXlsx').disabled = disabled;
  if ($('btnCsv')) $('btnCsv').disabled = disabled;
  if ($('btnReduce')) $('btnReduce').disabled = disabled || state.adjusting;
  if ($('btnClearProposed')) $('btnClearProposed').disabled = disabled || state.adjusting;
  if ($('btnSample')) $('btnSample').disabled = disabled;
  if ($('btnUploadSheet')) $('btnUploadSheet').disabled = state.busy || state.downloading || state.adjusting;
}

async function downloadSheet(format, { sample = false } = {}) {
  const spec = activeDownloadSpec();
  if (state.downloading) return;
  const count = countForSpec(spec);
  if (count === 0) return;
  state.downloading = true;
  renderDownloads();
  showBanner(sample ? `Preparing the ${spec.label} sample sheet.` : `Preparing the ${spec.label} ${format === 'xlsx' ? 'Excel' : 'CSV'} file.`, '');
  try {
    const response = await fetch(exportUrl(format, {
      prefix: spec.prefix,
      mrCategory: spec.mrCategory,
      q: '',
      sort: 'sku',
      dir: 'asc',
    }, sample ? { sample: '1' } : {}));
    if (!response.ok) throw new Error(`Download failed (${response.status}).`);
    const blob = await response.blob();
    const stamp = new Date().toISOString().slice(0, 10);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = sample
      ? `walmart-price-sample-${spec.file}-${stamp}.xlsx`
      : `walmart-prices-${spec.file}-${stamp}.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
    showBanner(sample ? `Downloaded the ${spec.label} sample. Fill Proposed Price, then upload the sheet.` : `Downloaded ${spec.label}.`, 'ok');
  } catch (err) {
    showBanner(err.message, 'bad');
  } finally {
    state.downloading = false;
    renderDownloads();
  }
}

function renderStats() {
  const summary = state.summary || {};
  const num = (value) => Number(value || 0).toLocaleString();
  const cards = [
    ['Total products', num(summary.total)],
    ['Prices retrieved', num(summary.withPrice)],
    ['Inventory retrieved', num(summary.withInventory)],
    ['Pending updates', num(summary.pending)],
    ['Successful updates', num(summary.success)],
    ['Failed updates', num(summary.failed)],
    ['Last price sync', summary.lastFetchedAt ? when(summary.lastFetchedAt) : 'Never'],
  ];
  $('stats').innerHTML = cards
    .map(([label, value]) => `<article class="stat"><b>${value}</b><span>${label}</span></article>`)
    .join('');
  const counts = { ...(summary.counts || {}) };
  if (state.sheetCounts) {
    counts.all = summary.total || 0;
    counts.is = state.sheetCounts.is;
    counts.mr = state.sheetCounts.mr;
    counts.exclude = Math.max(0, (summary.total || 0) - state.sheetCounts.is - state.sheetCounts.mr);
    counts.mrAll = state.sheetCounts.mr;
    counts.fa = state.sheetCounts.fa;
    counts.he = state.sheetCounts.he;
  }
  document.querySelectorAll('[data-count]').forEach((node) => {
    const value = counts[node.dataset.count];
    node.textContent = value == null ? '' : ` ${Number(value).toLocaleString()}`;
  });
}

function renderFilters() {
  document.querySelectorAll('[data-prefix]').forEach((button) => {
    button.classList.toggle('active', button.dataset.prefix === state.filters.prefix);
  });
  document.querySelectorAll('[data-mr]').forEach((button) => {
    button.classList.toggle('active', button.dataset.mr === state.filters.mrCategory);
  });
  $('search').value = state.filters.q || '';
  $('pageSize').value = String(state.filters.pageSize || 50);
  $('mrFilters').hidden = state.filters.prefix !== 'mr';
}

function renderJob() {
  const job = state.job;
  const bar = $('jobBar');
  if (!job || (job.status !== 'running' && !$('jobText').dataset.hold)) {
    if (!job) bar.hidden = true;
  }
  if (!job) return;
  bar.hidden = false;
  const total = Number(job.total) || 0;
  const processed = Number(job.processed) || 0;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : job.status === 'running' ? 12 : 100;
  $('jobFill').style.width = `${pct}%`;
  $('jobText').textContent = `${job.message || job.phase || 'Working'} · processed ${processed}${total ? ` / ${total}` : ''} · succeeded ${job.succeeded || 0} · failed ${job.failed || 0}`;
}

function renderRows() {
  const tbody = $('rows');
  if (!state.rows.length) {
    const waiting = state.job?.status === 'running'
      ? 'Fetching products from Walmart. Rows appear here as each page is saved.'
      : 'No products yet. Click Fetch products from Walmart.';
    tbody.innerHTML = `<tr><td colspan="10">${waiting}</td></tr>`;
  } else {
    tbody.innerHTML = state.rows
      .map((row) => {
        const checked = state.selection.has(row.sku) ? 'checked' : '';
        const diffClass = row.priceDifference > 0 ? 'diff-up' : row.priceDifference < 0 ? 'diff-down' : '';
        const status = row.feedItemStatus
          ? `${row.updateStatus || '—'} · ${row.feedItemStatus}`
          : (row.updateStatus || '—');
        const retry = row.updateStatus === 'Failed' ? `<button type="button" class="secondary" data-action="retry" data-sku="${escapeAttr(row.sku)}">Retry</button>` : '';
        return `<tr>
          <td><input type="checkbox" data-sku="${escapeAttr(row.sku)}" ${checked} aria-label="Select ${escapeAttr(row.sku)}" /></td>
          <td class="sku">${escapeHtml(row.sku)}</td>
          <td class="product-name">${escapeHtml(row.productName || '—')}</td>
          <td>${row.inventoryAvailable == null ? '—' : Number(row.inventoryAvailable).toLocaleString()}</td>
          <td>${money(row.walmartCurrentPrice)}</td>
          <td><input class="price-input" data-price="${escapeAttr(row.sku)}" type="number" min="0.01" step="0.01" value="${row.proposedPrice ?? ''}" /></td>
          <td class="${diffClass}">${differenceLabel(row.walmartCurrentPrice, row.proposedPrice)}</td>
          <td><span class="status ${escapeAttr(row.updateStatus)}">${escapeHtml(status)}</span>${row.errorMessage ? `<div class="meta">${escapeHtml(row.errorMessage)}</div>` : ''}</td>
          <td>${when(row.lastFetchedAt)}</td>
          <td class="row-actions">
            <button type="button" class="secondary" data-action="edit" data-sku="${escapeAttr(row.sku)}">Edit</button>
            <button type="button" class="secondary" data-action="save" data-sku="${escapeAttr(row.sku)}">Save</button>
            <button type="button" data-action="update" data-sku="${escapeAttr(row.sku)}">Update</button>
            ${retry}
          </td>
        </tr>`;
      })
      .join('');
  }
  const pageSkus = state.rows.map((row) => row.sku);
  const selectedOnPage = pageSkus.filter((sku) => state.selection.has(sku)).length;
  $('checkPage').checked = pageSkus.length > 0 && selectedOnPage === pageSkus.length;
  $('checkPage').indeterminate = selectedOnPage > 0 && selectedOnPage < pageSkus.length;
  const total = state.summary?.matched ?? 0;
  const page = state.filters.page || 1;
  const pageSize = state.filters.pageSize || 50;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  $('pageMeta').textContent = `${from}–${to} of ${total} · ${state.selection.size} selected`;
  $('btnPrev').disabled = page <= 1 || state.busy;
  $('btnNext').disabled = page * pageSize >= total || state.busy;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function setBusy(busy) {
  state.busy = busy;
  const running = busy || state.job?.status === 'running';
  $('btnFetch').disabled = running;
  if ($('btnInventory')) $('btnInventory').disabled = running;
  $('btnUpdateSelected').disabled = running || state.selection.size === 0;
  $('btnUpdateFilter').disabled = running;
  $('btnUpdateAll').disabled = running || !(state.summary?.eligible > 0);
  $('btnRetryFailed').disabled = running || !(state.summary?.failed > 0);
  if ($('btnReduce')) $('btnReduce').disabled = running || state.adjusting || state.downloading;
  if ($('btnClearProposed')) $('btnClearProposed').disabled = running || state.adjusting || state.downloading;
  renderRows();
  renderDownloads();
}

async function refresh() {
  state.summary = await api.summary(state.filters);
  if (!state.summary.sheets && !state.sheetCounts) {
    const base = await api.summary({ prefix: 'all', mrCategory: 'any', q: '' });
    noteSheetCounts(base, { full: true });
  } else {
    noteSheetCounts(state.summary);
  }
  const page = await api.list(state.filters);
  state.rows = page.rows || [];
  state.filters.page = page.page;
  if (state.summary) state.summary.counts = page.counts || state.summary.counts;
  state.summary.matched = page.total;
  renderStats();
  renderFilters();
  renderRows();
  renderDownloads();
  setBusy(state.job?.status === 'running');
}

async function poll(jobId) {
  if (state.polling) return;
  state.polling = true;
  try {
    while (true) {
      const { job } = await api.job(jobId);
      state.job = job;
      renderJob();
      if (job?.status === 'running') await refresh();
      setBusy(job?.status === 'running');
      if (!job || job.status !== 'running') {
        showBanner(job?.message || 'Finished.', job?.status === 'failed' ? 'bad' : 'ok');
        await refresh();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } finally {
    state.polling = false;
  }
}

async function beginJob(starter) {
  if (state.job?.status === 'running' || state.starting) return;
  state.starting = true;
  setBusy(true);
  showBanner('');
  try {
    const { job } = await starter();
    state.job = job;
    renderJob();
    poll(job.id);
  } catch (err) {
    setBusy(false);
    showBanner(err.message, 'bad');
  } finally {
    state.starting = false;
  }
}

async function flushVisiblePrices() {
  for (const row of state.rows) {
    const input = document.querySelector(`[data-price="${CSS.escape(row.sku)}"]`);
    if (!input) continue;
    const raw = input.value.trim();
    if (raw === '') {
      if (row.proposedPrice != null) await api.saveProposed(row.sku, '');
      continue;
    }
    if (Number(row.proposedPrice) === Number(raw)) continue;
    await api.saveProposed(row.sku, raw);
  }
}

async function openConfirm(scope, skus, { filter } = {}) {
  if (state.confirming || state.busy) return false;
  const applied = filter || currentFilterBody();
  state.confirming = true;
  try {
  await flushVisiblePrices();
  setBusy(true);
  const preview = await api.preview({ scope, skus, filter: applied });
  if (!preview.count) {
    const reason = preview.invalid?.[0]?.message || preview.notFound?.[0] || 'Nothing eligible to update.';
    showBanner(typeof reason === 'string' ? reason : 'Nothing eligible to update.', 'bad');
    return false;
  }
  $('confirmTitle').textContent = 'Send these prices to Walmart?';
  $('confirmScope').textContent = `This would update ${preview.count} ${preview.scopeText}. ${preview.skipped} unchanged products are skipped.`;
  $('confirmRows').innerHTML = preview.sample
    .map(
      (row) =>
        `<tr><td class="sku">${escapeHtml(row.sku)}</td><td>${money(row.walmartCurrentPrice)}</td><td>${money(row.proposedPrice)}</td><td>${differenceLabel(row.walmartCurrentPrice, row.proposedPrice)}</td></tr>`,
    )
    .join('');
  $('confirmMore').textContent = preview.count > preview.sample.length ? `And ${preview.count - preview.sample.length} more products.` : '';
  const dialog = $('confirmDialog');
  const go = await new Promise((resolve) => {
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener('close', onClose);
      $('confirmCancel').onclick = null;
      $('confirmGo').onclick = null;
      resolve(answer);
    };
    const onClose = () => finish(false);
    dialog.addEventListener('close', onClose);
    $('confirmCancel').onclick = () => dialog.close();
    $('confirmGo').onclick = () => {
      finish(true);
      dialog.close();
    };
    dialog.returnValue = '';
    dialog.showModal();
    $('confirmCancel').focus();
  });
  if (!go) return false;
  await beginJob(() => api.update({ scope, skus, filter: applied, confirm: true }));
  return true;
  } finally {
    state.confirming = false;
    if (state.job?.status !== 'running') setBusy(false);
  }
}

function proposedFromRow(sku) {
  const input = document.querySelector(`[data-price="${CSS.escape(sku)}"]`);
  return input ? input.value : '';
}

async function saveSku(sku, proposedPrice, { silent } = {}) {
  const result = await api.saveProposed(sku, proposedPrice);
  const cleared = proposedPrice == null || String(proposedPrice).trim() === '';
  if (!silent) {
    showBanner(
      cleared ? `Cleared the proposed price for ${sku}.` : `Saved proposed price for ${sku}. This is not on Walmart yet.`,
      'ok',
    );
  }
  await refresh();
  return result.row;
}

document.querySelectorAll('[data-prefix]').forEach((button) => {
  button.addEventListener('click', () => {
    state.filters.prefix = button.dataset.prefix;
    if (state.filters.prefix !== 'mr') state.filters.mrCategory = 'any';
    state.filters.page = 1;
    saveFilters(state.filters);
    refresh().catch((err) => showBanner(err.message, 'bad'));
  });
});

document.querySelectorAll('[data-mr]').forEach((button) => {
  button.addEventListener('click', () => {
    state.filters.mrCategory = button.dataset.mr;
    state.filters.page = 1;
    saveFilters(state.filters);
    refresh().catch((err) => showBanner(err.message, 'bad'));
  });
});

$('btnClearFilters').addEventListener('click', () => {
  state.filters = { ...state.filters, prefix: 'all', mrCategory: 'any', q: '', page: 1 };
  saveFilters(state.filters);
  refresh().catch((err) => showBanner(err.message, 'bad'));
});

$('search').addEventListener('input', () => {
  state.filters.q = $('search').value.trim();
  state.filters.page = 1;
  saveFilters(state.filters);
  clearTimeout($('search')._timer);
  $('search')._timer = setTimeout(() => {
    refresh().catch((err) => showBanner(err.message, 'bad'));
  }, 250);
});

document.querySelectorAll('.sort').forEach((button) => {
  button.addEventListener('click', () => {
    const sort = button.dataset.sort;
    if (state.filters.sort === sort) state.filters.dir = state.filters.dir === 'asc' ? 'desc' : 'asc';
    else {
      state.filters.sort = sort;
      state.filters.dir = 'asc';
    }
    saveFilters(state.filters);
    refresh().catch((err) => showBanner(err.message, 'bad'));
  });
});

$('checkPage').addEventListener('change', () => {
  for (const row of state.rows) {
    if ($('checkPage').checked) state.selection.add(row.sku);
    else state.selection.delete(row.sku);
  }
  saveSelection(state.selection);
  renderRows();
  setBusy(state.job?.status === 'running');
});

$('rows').addEventListener('change', (event) => {
  const priceInput = event.target.closest('input.price-input[data-price]');
  if (priceInput && !state.busy) {
    const sku = priceInput.dataset.price;
    const row = state.rows.find((item) => item.sku === sku);
    const raw = priceInput.value.trim();
    const unchanged = raw === '' ? row?.proposedPrice == null : Number(row?.proposedPrice) === Number(raw);
    if (!unchanged) {
      saveSku(sku, raw).catch((err) => showBanner(err.message, 'bad'));
    }
    return;
  }
  const box = event.target.closest('input[type="checkbox"][data-sku]');
  if (!box) return;
  if (box.checked) state.selection.add(box.dataset.sku);
  else state.selection.delete(box.dataset.sku);
  saveSelection(state.selection);
  renderRows();
  setBusy(state.job?.status === 'running');
});

$('rows').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || state.busy) return;
  const sku = button.dataset.sku;
  const action = button.dataset.action;
  try {
    if (action === 'edit') {
      const row = state.rows.find((item) => item.sku === sku);
      state.editSku = sku;
      $('editSku').textContent = sku;
      $('editCurrent').textContent = money(row?.walmartCurrentPrice);
      $('editPrice').value = row?.proposedPrice ?? '';
      $('editDiff').textContent = '';
      $('editDialog').showModal();
      return;
    }
    if (action === 'save') {
      await saveSku(sku, proposedFromRow(sku));
      return;
    }
    if (action === 'update' || action === 'retry') {
      const price = proposedFromRow(sku).trim();
      await saveSku(sku, price, { silent: true });
      if (price === '') {
        showBanner(`Cleared the proposed price for ${sku}. Nothing was sent to Walmart.`, 'ok');
        return;
      }
      await openConfirm('selected', [sku]);
    }
  } catch (err) {
    showBanner(err.message, 'bad');
  }
});

async function applyReduction() {
  if (state.adjusting || state.busy || state.downloading) return;
  const percent = Number($('reducePercent').value);
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
    showBanner('Enter a percent from 1 to 99. This only fills the proposed price in the table.', 'bad');
    return;
  }
  const spec = activeDownloadSpec();
  const filter = {
    prefix: spec.prefix,
    mrCategory: spec.mrCategory,
    q: '',
    sort: state.filters.sort,
    dir: state.filters.dir,
  };
  state.adjusting = true;
  renderDownloads();
  showBanner(`Filling proposed prices for ${spec.label} at ${percent}% less. Nothing is sent to Walmart.`, '');
  try {
    const result = await api.adjust({ percent, filter });
    await refresh();
    if (!result.updated) {
      showBanner(`No ${spec.label} products had a price that could be lowered.`, 'bad');
      return;
    }
    showBanner(`Filled ${Number(result.updated).toLocaleString()} ${spec.label} proposed prices at ${percent}% less. Nothing was sent to Walmart.`, 'ok');
  } catch (err) {
    showBanner(err.message, 'bad');
  } finally {
    state.adjusting = false;
    if (state.job?.status !== 'running') setBusy(false);
  }
}

$('btnReduce').addEventListener('click', () => {
  applyReduction().catch((err) => showBanner(err.message, 'bad'));
});

async function clearProposedPrices() {
  if (state.adjusting || state.busy || state.downloading) return;
  const spec = activeDownloadSpec();
  const filter = {
    prefix: spec.prefix,
    mrCategory: spec.mrCategory,
    q: '',
    sort: state.filters.sort,
    dir: state.filters.dir,
  };
  state.adjusting = true;
  renderDownloads();
  showBanner(`Clearing proposed prices for ${spec.label}.`, '');
  try {
    const result = await api.clearProposed({ filter });
    await refresh();
    const cleared = Number(result.cleared) || 0;
    if (!cleared) {
      showBanner(`No ${spec.label} products had a proposed price.`, 'ok');
      return;
    }
    showBanner(`Cleared proposed prices on ${cleared.toLocaleString()} ${spec.label} products. Walmart prices are unchanged.`, 'ok');
  } catch (err) {
    showBanner(err.message, 'bad');
  } finally {
    state.adjusting = false;
    if (state.job?.status !== 'running') setBusy(false);
  }
}

$('btnClearProposed').addEventListener('click', () => {
  clearProposedPrices().catch((err) => showBanner(err.message, 'bad'));
});

function readSheetFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const comma = text.indexOf(',');
      resolve(comma >= 0 ? text.slice(comma + 1) : text);
    };
    reader.onerror = () => reject(new Error('Could not read the sheet.'));
    reader.readAsDataURL(file);
  });
}

async function uploadPriceSheet(file) {
  if (!file || state.adjusting || state.busy || state.downloading) return;
  const name = file.name || '';
  if (!/\.(xlsx|csv)$/i.test(name)) {
    showBanner('Upload an Excel .xlsx or CSV sheet.', 'bad');
    return;
  }
  state.adjusting = true;
  renderDownloads();
  showBanner('Reading prices from the sheet.', '');
  try {
    const fileBase64 = await readSheetFile(file);
    const result = await api.importSheet({ filename: name, fileBase64 });
    await refresh();
    const unknownNote = result.unknown ? ` ${Number(result.unknown).toLocaleString()} SKUs were not in the catalog.` : '';
    const invalidNote = result.invalid ? ` ${Number(result.invalid).toLocaleString()} prices were not valid.` : '';
    if (!result.updated) {
      if (result.skipped) {
        showBanner(`${Number(result.skipped).toLocaleString()} prices from the sheet are already in the table. Nothing was sent to Walmart.`, 'ok');
        return;
      }
      showBanner(`No prices were applied.${unknownNote}${invalidNote}`, 'bad');
      return;
    }
    showBanner(`Filled ${Number(result.updated).toLocaleString()} proposed prices in the table.${unknownNote}${invalidNote} Nothing was sent to Walmart.`, 'ok');
  } catch (err) {
    showBanner(err.message, 'bad');
  } finally {
    state.adjusting = false;
    if (state.job?.status !== 'running') setBusy(false);
  }
}

$('btnSample').addEventListener('click', () => {
  downloadSheet('xlsx', { sample: true }).catch((err) => showBanner(err.message, 'bad'));
});
$('btnUploadSheet').addEventListener('click', () => {
  $('priceSheetFile').click();
});
$('priceSheetFile').addEventListener('change', () => {
  const file = $('priceSheetFile').files?.[0];
  $('priceSheetFile').value = '';
  uploadPriceSheet(file).catch((err) => showBanner(err.message, 'bad'));
});

$('btnXlsx').addEventListener('click', () => {
  downloadSheet('xlsx').catch((err) => showBanner(err.message, 'bad'));
});
$('btnCsv').addEventListener('click', () => {
  downloadSheet('csv').catch((err) => showBanner(err.message, 'bad'));
});

$('btnFetch').addEventListener('click', () => beginJob(() => api.fetchPrices()));
$('btnInventory').addEventListener('click', () => beginJob(() => api.fetchInventory()));
$('btnUpdateSelected').addEventListener('click', () => {
  openConfirm('selected', [...state.selection]).catch((err) => showBanner(err.message, 'bad'));
});
$('btnUpdateFilter').addEventListener('click', () => {
  openConfirm('filter').catch((err) => showBanner(err.message, 'bad'));
});
$('btnUpdateAll').addEventListener('click', () => {
  openConfirm('all').catch((err) => showBanner(err.message, 'bad'));
});
$('btnRetryFailed').addEventListener('click', () => {
  openConfirm('failed').catch((err) => showBanner(err.message, 'bad'));
});

$('btnPrev').addEventListener('click', () => {
  state.filters.page = Math.max(1, (state.filters.page || 1) - 1);
  saveFilters(state.filters);
  refresh().catch((err) => showBanner(err.message, 'bad'));
});
$('btnNext').addEventListener('click', () => {
  state.filters.page = (state.filters.page || 1) + 1;
  saveFilters(state.filters);
  refresh().catch((err) => showBanner(err.message, 'bad'));
});
$('pageSize').addEventListener('change', () => {
  state.filters.pageSize = Number($('pageSize').value) || 50;
  state.filters.page = 1;
  saveFilters(state.filters);
  refresh().catch((err) => showBanner(err.message, 'bad'));
});

$('confirmCancel').addEventListener('click', () => {
  if ($('confirmDialog').open) $('confirmDialog').close();
});
$('editCancel').addEventListener('click', () => $('editDialog').close());
$('editPrice').addEventListener('input', () => {
  const row = state.rows.find((item) => item.sku === state.editSku);
  const label = differenceLabel(row?.walmartCurrentPrice, $('editPrice').value);
  $('editDiff').textContent = label === '—' ? '' : label;
});
$('editForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await saveSku(state.editSku, $('editPrice').value);
    $('editDialog').close();
  } catch (err) {
    showBanner(err.message, 'bad');
  }
});
$('editUpdate').addEventListener('click', async () => {
  try {
    const price = $('editPrice').value.trim();
    await saveSku(state.editSku, price, { silent: true });
    $('editDialog').close();
    if (price === '') {
      showBanner(`Cleared the proposed price for ${state.editSku}. Nothing was sent to Walmart.`, 'ok');
      return;
    }
    await openConfirm('selected', [state.editSku]);
  } catch (err) {
    showBanner(err.message, 'bad');
  }
});

$('adminToken').value = adminToken();
$('adminToken').addEventListener('change', () => saveAdminToken($('adminToken').value.trim()));

const meta = await api.meta();
$('tokenLabel').hidden = !meta.updatesRequireToken;
if (!meta.credentialsConfigured) {
  showBanner('Walmart credentials are not configured. Fetch and update stay disabled until WALMART_CLIENT_ID and WALMART_CLIENT_SECRET are set.', 'bad');
}
try {
  await refresh();
  const running = state.summary?.activeJob;
  if (running?.status === 'running') {
    state.job = running;
    renderJob();
    poll(running.id);
  }
} catch (err) {
  showBanner(err.message, 'bad');
}
