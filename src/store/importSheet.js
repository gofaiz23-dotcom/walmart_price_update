import { parseCsv } from '../walmart/parse.js';

const SKU_HEADERS = new Set(['sku', 'seller sku', 'item sku']);
const PROPOSED_HEADERS = new Set(['proposed price', 'new price', 'update price']);

function headerKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (value.result != null) return cellText(value.result);
    if (value.text != null) return cellText(value.text);
    if (value.richText) return value.richText.map((part) => part.text || '').join('');
  }
  return String(value).trim();
}

/** Read SKU + Proposed Price. A plain Price column is used only when Proposed Price is absent. */
export function priceRowsFromTable(table) {
  const rows = Array.isArray(table) ? table : [];
  if (!rows.length) {
    const error = new Error('The sheet is empty.');
    error.statusCode = 400;
    throw error;
  }
  const headers = rows[0].map(headerKey);
  const skuIndex = headers.findIndex((header) => SKU_HEADERS.has(header));
  let priceIndex = headers.findIndex((header) => PROPOSED_HEADERS.has(header));
  if (priceIndex < 0) priceIndex = headers.findIndex((header) => header === 'price');
  if (skuIndex < 0 || priceIndex < 0) {
    const error = new Error('The sheet needs a SKU column and a Proposed Price column.');
    error.statusCode = 400;
    throw error;
  }
  const updates = [];
  for (const line of rows.slice(1)) {
    const sku = cellText(line?.[skuIndex]);
    const proposedPrice = cellText(line?.[priceIndex]);
    if (!sku || !proposedPrice) continue;
    updates.push({ sku, proposedPrice });
  }
  if (!updates.length) {
    const error = new Error('No proposed prices were filled in. Type the new price in the Proposed Price column.');
    error.statusCode = 400;
    throw error;
  }
  return updates;
}

export async function priceRowsFromBuffer(buffer, filename = '') {
  const name = String(filename || '').toLowerCase();
  const bytes = Buffer.from(buffer);
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    return priceRowsFromTable(parseCsv(bytes.toString('utf8')));
  }
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await workbookWithoutNotes(bytes));
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    const error = new Error('The workbook has no sheet.');
    error.statusCode = 400;
    throw error;
  }
  const table = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      values[col - 1] = cellText(cell.value);
    });
    table.push(values);
  });
  return priceRowsFromTable(table);
}

/** Excel rewrites cell notes into comment parts that the reader cannot open. Prices do not need those notes. */
async function workbookWithoutNotes(buffer) {
  const { default: JSZip } = await import('jszip');
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return buffer;
  }
  for (const name of Object.keys(zip.files)) {
    const lower = name.toLowerCase();
    if (lower.includes('comment') || lower.includes('vmldrawing') || lower.endsWith('.vml')) {
      zip.remove(name);
    }
  }
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    const lower = name.toLowerCase();
    if (lower.endsWith('.rels') || lower === '[content_types].xml' || /xl\/worksheets\/sheet\d+\.xml$/.test(lower)) {
      const xml = await zip.file(name).async('string');
      const next = xml
        .replace(/<Relationship\b[^>]*\/>/g, (tag) => (/comments|vmlDrawing|threadedComment/i.test(tag) ? '' : tag))
        .replace(/<Override\b[^>]*\/>/g, (tag) => (/comment|vml/i.test(tag) ? '' : tag))
        .replace(/<legacyDrawing\b[^>]*\/>/g, '')
        .replace(/<legacyDrawingHF\b[^>]*\/>/g, '');
      if (next !== xml) zip.file(name, next);
    }
  }
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}
