import fs from 'node:fs/promises';
import path from 'node:path';
import { priceDifference } from '../validation/prices.js';

export const EXPORT_COLUMNS = [
  ['sku', 'SKU'],
  ['walmartCurrentPrice', 'Walmart Current Price'],
  ['proposedPrice', 'Proposed Price'],
  ['priceDifference', 'Price Difference'],
  ['lastFetchedAt', 'Last Fetched At'],
  ['lastUpdatedAt', 'Last Updated At'],
  ['updateStatus', 'Update Status'],
  ['errorMessage', 'Error Message'],
  ['lastSubmittedPrice', 'Last Submitted Price'],
  ['currency', 'Currency'],
  ['productName', 'Product Name'],
];

export function rowsForExport(records) {
  return records.map((record) => ({
    sku: record.sku,
    walmartCurrentPrice: record.walmartCurrentPrice ?? '',
    proposedPrice: record.proposedPrice ?? '',
    priceDifference: priceDifference(record.walmartCurrentPrice, record.proposedPrice) ?? '',
    lastFetchedAt: record.lastFetchedAt || '',
    lastUpdatedAt: record.lastUpdatedAt || '',
    updateStatus: record.updateStatus || '',
    errorMessage: record.errorMessage || '',
    lastSubmittedPrice: record.lastSubmittedPrice ?? '',
    currency: record.currency || 'USD',
    productName: record.productName || '',
  }));
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(records) {
  const rows = rowsForExport(records);
  const header = EXPORT_COLUMNS.map(([, label]) => csvCell(label)).join(',');
  const lines = rows.map((row) => EXPORT_COLUMNS.map(([key]) => csvCell(row[key])).join(','));
  return `\uFEFF${[header, ...lines].join('\r\n')}\r\n`;
}

export async function toXlsxBuffer(records) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Walmart Price Management';
  const sheet = workbook.addWorksheet('Walmart Prices');
  sheet.columns = EXPORT_COLUMNS.map(([key, header]) => ({ header, key, width: Math.max(18, header.length + 2) }));
  sheet.addRows(rowsForExport(records));
  sheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export function exportScope(filter = {}) {
  const prefix = filter.prefix || 'all';
  const mr = filter.mrCategory || 'any';
  if (prefix === 'is') return 'IS';
  if (prefix === 'mr' && mr === '01FA') return 'MR-01FA';
  if (prefix === 'mr' && mr === '04HE') return 'MR-04HE';
  if (prefix === 'mr' || mr === 'mr') return 'MR';
  if (prefix === 'exclude') return 'other';
  if (String(filter.q || '').trim()) return 'search';
  return 'all';
}

export function exportFileName(format, scope = 'all') {
  const stamp = new Date().toISOString().slice(0, 10);
  const label = scope === true ? 'filtered' : scope === false || scope == null || scope === '' ? 'all' : String(scope);
  const safe = label.replace(/[^\w.-]+/g, '') || 'all';
  return `walmart-prices-${safe}-${stamp}.${format}`;
}

export async function writeExportFile(dir, format, records, filtered) {
  await fs.mkdir(dir, { recursive: true });
  const name = exportFileName(format, filtered);
  const target = path.join(dir, name);
  if (format === 'csv') {
    await fs.writeFile(target, toCsv(records), 'utf8');
  } else {
    await fs.writeFile(target, await toXlsxBuffer(records));
  }
  return { name, target };
}
