/** Money helpers. Prices are USD amounts with cent precision. */

export function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function parseMoney(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? roundMoney(value) : null;
  }
  const cleaned = String(value).trim().replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return roundMoney(n);
}

export function moneyEqual(a, b) {
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

/** A reduction of 50 turns 20.00 into 10.00. 0 and 100 are not allowed. */
export function parsePercentOff(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return null;
  return roundMoney(n);
}

export function reducedPrice(current, percentOff) {
  const percent = parsePercentOff(percentOff);
  const base = parseMoney(current);
  if (percent == null || base == null || base <= 0) return null;
  const cents = Math.round(base * 100);
  const kept = Math.round((cents * (100 - percent)) / 100);
  const amount = kept / 100;
  if (amount < 0.01 || Math.abs(amount - base) < 0.005) return null;
  return amount;
}

export function priceDifference(current, proposed) {
  if (current == null || proposed == null) return null;
  return roundMoney(Number(proposed) - Number(current));
}

/**
 * @returns {{ ok: true, amount: number } | { ok: false, message: string }}
 */
export function validateProposedPrice(value, { maxPrice = 100_000 } = {}) {
  if (value == null || value === '') {
    return { ok: false, message: 'Enter a proposed price.' };
  }
  const amount = parseMoney(value);
  if (amount == null) {
    return { ok: false, message: 'Proposed price must be a number.' };
  }
  if (amount <= 0) {
    return { ok: false, message: 'Proposed price must be greater than 0.' };
  }
  if (amount > maxPrice) {
    return { ok: false, message: `Proposed price must be at most ${maxPrice}.` };
  }
  const text = String(value).trim().replace(/[$,\s]/g, '');
  if (/^\d+(\.\d+)?$/.test(text)) {
    const decimals = text.includes('.') ? text.split('.')[1].length : 0;
    if (decimals > 2) {
      return { ok: false, message: 'Proposed price can have at most 2 decimal places.' };
    }
  }
  return { ok: true, amount };
}

export function sanitizeError(err) {
  let msg = err && typeof err === 'object' && err.message ? err.message : String(err || 'Unknown error');
  msg = msg
    .replace(/access_token["']?\s*[:=]\s*["'][^"']+/gi, 'access_token=[redacted]')
    .replace(/WM_SEC\.ACCESS_TOKEN\s*[:=]\s*\S+/gi, 'WM_SEC.ACCESS_TOKEN=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]');
  if (msg.length > 400) msg = `${msg.slice(0, 400)}…`;
  return msg;
}
