const MAX_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Parse "30s", "10m", "2h", "1d", "1h30m", "5 mins", "2 hours".
 * A bare number means minutes. Returns milliseconds, or null if invalid.
 */
function parseDuration(input) {
  if (!input) return null;
  let s = String(input).toLowerCase().replace(/\s+/g, '');
  s = s
    .replace(/(seconds?|secs?)/g, 's')
    .replace(/(minutes?|mins?)/g, 'm')
    .replace(/(hours?|hrs?)/g, 'h')
    .replace(/(days?)/g, 'd');

  if (/^\d+(\.\d+)?$/.test(s)) s += 'm';
  if (!/^(\d+(\.\d+)?[smhd])+$/.test(s)) return null;

  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  let total = 0;
  for (const [, n, u] of s.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) total += parseFloat(n) * unit[u];

  total = Math.round(total);
  if (total < 1000) return null;
  return Math.min(total, MAX_MS);
}

/** 5400000 -> "1h 30m" */
function formatDuration(ms) {
  const parts = [];
  let s = Math.round(ms / 1000);
  for (const [label, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    const v = Math.floor(s / size);
    if (v) parts.push(`${v}${label}`);
    s -= v * size;
  }
  return parts.join(' ') || '0s';
}

module.exports = { parseDuration, formatDuration, MAX_MS };
