const { groupPayslipLines, sumLineAmounts } = require('./payslipLines');

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function computeElementAmount(element, basicSalary) {
  const calcType = String(element?.calc_type || 'fixed').trim().toLowerCase();
  const calcValue = Number(element?.calc_value) || 0;
  if (calcType === 'percent_of_basic') {
    return roundMoney((basicSalary * calcValue) / 100);
  }
  return roundMoney(calcValue);
}

function formatPeriodMonth(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function buildRunDates(periodMonth) {
  const match = String(periodMonth || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    const fallback = formatPeriodMonth();
    return buildRunDates(fallback);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    period_month: `${match[1]}-${match[2]}`,
    pay_date: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`,
    is_off_cycle: false,
  };
}

function buildLinesFromProfile({ basicSalary, elements }) {
  const lines = [];
  const safeBasic = roundMoney(basicSalary);

  if (safeBasic > 0) {
    lines.push({
      id: null,
      line_kind: 'basic',
      label: 'Basic Salary',
      amount: safeBasic,
      source_ref: null,
    });
  }

  for (const element of elements || []) {
    const kind = String(element?.kind || '').trim().toLowerCase();
    if (!['allowance', 'deduction', 'contribution'].includes(kind)) continue;

    lines.push({
      id: element.id,
      line_kind: kind,
      label: String(element.payslip_name || element.name || 'Pay item').trim() || 'Pay item',
      amount: computeElementAmount(element, safeBasic),
      source_ref: `pe:${element.id}`,
    });
  }

  return lines;
}

function buildTotalsFromLines(lines) {
  const { earnings, deductions, contributions } = groupPayslipLines(lines);
  const basicLine = lines.find((line) => line.line_kind === 'basic');
  const basicSalary = roundMoney(basicLine?.amount ?? 0);
  const totalAllowances = roundMoney(
    sumLineAmounts(earnings.filter((line) => line.line_kind !== 'basic'))
  );
  const totalDeductions = roundMoney(sumLineAmounts(deductions));
  const totalContributions = roundMoney(sumLineAmounts(contributions));
  const grossPay = roundMoney(sumLineAmounts(earnings));
  const netPay = roundMoney(grossPay - totalDeductions);

  return {
    basic_salary: basicSalary,
    total_allowances: totalAllowances,
    total_deductions: totalDeductions,
    total_contributions: totalContributions,
    gross_pay: grossPay,
    net_pay: netPay,
  };
}

function buildPayslipDataFromEmployeeProfile({
  employeeRow,
  companyRow,
  template,
  elements,
  periodMonth,
}) {
  const basicSalary = roundMoney(employeeRow?.salary ?? 0);
  const currency = String(employeeRow?.currency || companyRow?.currency || 'PKR').trim() || 'PKR';
  const lines = buildLinesFromProfile({ basicSalary, elements });
  const run = buildRunDates(periodMonth || formatPeriodMonth());

  return {
    payroll_run_id: null,
    payroll_run_employee_id: null,
    company: {
      id: companyRow?.company_id || companyRow?.id || null,
      name: companyRow?.company_name || 'Company',
      address: companyRow?.company_address || '',
      logo_url: companyRow?.logo_url || null,
      logo_buffer: companyRow?.logo_buffer || null,
    },
    run,
    employee: {
      id: Number(employeeRow?.id),
      name: employeeRow?.name || 'Employee',
      employee_code: employeeRow?.employee_code || '',
      designation: employeeRow?.designation || '',
      department: employeeRow?.department || '',
      email: employeeRow?.work_email || '',
    },
    attendance: {
      present_days: Number(employeeRow?.present_days ?? 26),
      absent_days: Number(employeeRow?.absent_days ?? 0),
      working_days: Number(employeeRow?.working_days ?? 26),
    },
    totals: buildTotalsFromLines(lines),
    lines,
    currency,
    salary_template: template
      ? {
          id: Number(template.id),
          name: template.name,
        }
      : null,
  };
}

module.exports = {
  buildPayslipDataFromEmployeeProfile,
  buildLinesFromProfile,
  buildTotalsFromLines,
  computeElementAmount,
  roundMoney,
};
