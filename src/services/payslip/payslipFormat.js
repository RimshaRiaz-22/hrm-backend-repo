const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function formatPeriodMonth(periodMonth) {
  const match = String(periodMonth || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) return String(periodMonth || '').trim() || '—';
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return periodMonth;
  return `${MONTH_NAMES[monthIndex]} ${year}`;
}

function toDateOnlyParts(value) {
  if (!value) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return {
      year: value.getFullYear(),
      month: value.getMonth(),
      day: value.getDate(),
    };
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return {
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]) - 1,
      day: Number(isoMatch[3]),
    };
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    year: parsed.getUTCFullYear(),
    month: parsed.getUTCMonth(),
    day: parsed.getUTCDate(),
  };
}

function normalizePayDate(value) {
  const parts = toDateOnlyParts(value);
  if (!parts) return null;
  const month = String(parts.month + 1).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

function formatPayDate(payDate) {
  const parts = toDateOnlyParts(payDate);
  if (!parts) return '—';
  if (parts.month < 0 || parts.month > 11) return '—';
  return `${parts.day} ${MONTH_NAMES[parts.month]} ${parts.year}`;
}

function formatMoney(amount, currency = 'PKR') {
  const value = Number(amount);
  const safe = Number.isFinite(value) ? value : 0;
  const formatted = Math.abs(safe).toLocaleString('en-PK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency} ${formatted}`;
}

function truncateToWidth(doc, text, maxWidth, fontSize = 10) {
  let value = String(text || '').trim() || '—';
  doc.fontSize(fontSize);
  if (doc.widthOfString(value) <= maxWidth) return value;
  while (value.length > 1 && doc.widthOfString(`${value}…`) > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}…`;
}

module.exports = {
  formatPeriodMonth,
  formatPayDate,
  normalizePayDate,
  formatMoney,
  truncateToWidth,
};
