const CONTRIBUTION_KIND = 'contribution';
const EARNING_KINDS = new Set(['basic', 'allowance', 'expense']);
const DEDUCTION_KINDS = new Set(['deduction', 'loan', 'absence']);

function normalizeAmount(amount) {
  const value = Number(amount);
  return Number.isFinite(value) ? value : 0;
}

function classifyPayslipLine(line) {
  const kind = String(line?.line_kind || '').trim().toLowerCase();
  const amount = normalizeAmount(line?.amount);

  if (kind === CONTRIBUTION_KIND) return 'contribution';
  if (EARNING_KINDS.has(kind)) return 'earning';
  if (DEDUCTION_KINDS.has(kind)) return 'deduction';
  if (kind === 'monthly_input') return amount < 0 ? 'deduction' : 'earning';
  return amount < 0 ? 'deduction' : 'earning';
}

function groupPayslipLines(lines = []) {
  const earnings = [];
  const deductions = [];
  const contributions = [];

  for (const line of lines) {
    const bucket = classifyPayslipLine(line);
    const normalized = {
      label: String(line?.label || '').trim() || '—',
      amount: normalizeAmount(line?.amount),
      line_kind: line?.line_kind || null,
      source_ref: line?.source_ref ?? null,
    };

    if (bucket === 'contribution') {
      contributions.push(normalized);
    } else if (bucket === 'deduction') {
      deductions.push({
        ...normalized,
        amount: Math.abs(normalized.amount),
      });
    } else {
      earnings.push(normalized);
    }
  }

  return { earnings, deductions, contributions };
}

function sumLineAmounts(items) {
  return items.reduce((total, item) => total + normalizeAmount(item.amount), 0);
}

module.exports = {
  classifyPayslipLine,
  groupPayslipLines,
  sumLineAmounts,
  normalizeAmount,
};
