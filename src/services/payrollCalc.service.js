/** Pure payroll calculation — no database I/O. */

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function calcElementAmount(element, basicSalary, presentDays, workingDays) {
  const calcValue = Number(element.calc_value) || 0;
  let amount = 0;

  if (element.calc_type === 'percent_of_basic') {
    amount = (basicSalary * calcValue) / 100;
  } else {
    amount = calcValue;
  }

  if (element.based_on === 'present_days' && workingDays > 0) {
    amount = (amount * presentDays) / workingDays;
  }

  return roundMoney(amount);
}

function totalsFromLines(lines) {
  let basicSalary = 0;
  let totalAllowances = 0;
  let totalDeductions = 0;
  let totalContributions = 0;

  for (const line of lines) {
    const amount = roundMoney(line.amount);
    if (line.line_kind === 'basic') {
      basicSalary = amount;
    } else if (
      line.line_kind === 'allowance' ||
      line.line_kind === 'monthly_input' ||
      line.line_kind === 'expense'
    ) {
      totalAllowances += amount;
    } else if (line.line_kind === 'deduction' || line.line_kind === 'loan' || line.line_kind === 'absence') {
      totalDeductions += amount;
    } else if (line.line_kind === 'contribution') {
      totalContributions += amount;
    }
  }

  const grossPay = roundMoney(basicSalary + totalAllowances);
  const netPay = roundMoney(grossPay - totalDeductions - totalContributions);

  return {
    basic_salary: basicSalary,
    total_allowances: roundMoney(totalAllowances),
    total_deductions: roundMoney(totalDeductions),
    total_contributions: roundMoney(totalContributions),
    gross_pay: grossPay,
    net_pay: netPay,
  };
}

/**
 * Calculate one employee's payroll from assembled inputs.
 */
function calculateEmployeePay({
  basicSalary = 0,
  presentDays = 0,
  absentDays = 0,
  workingDays = 0,
  absenceDeductionAmount = 0,
  payElements = [],
  monthlyInputs = [],
  loans = [],
  expenses = [],
}) {
  const basic = roundMoney(basicSalary);
  const working = workingDays > 0 ? workingDays : presentDays + absentDays;
  const present = presentDays > 0 ? presentDays : working;
  const absences = Math.max(0, Number(absentDays) || 0);

  const lines = [
    {
      line_kind: 'basic',
      label: 'Basic Salary',
      amount: basic,
      source_ref: 'basic_salary',
    },
  ];

  for (const element of payElements) {
    if (element.is_active === false) continue;
    const amount = calcElementAmount(element, basic, present, working);
    if (amount === 0) continue;

    lines.push({
      line_kind: element.kind,
      label: element.payslip_name || element.name,
      amount,
      source_ref: `pay_element:${element.id}`,
    });
  }

  for (const input of monthlyInputs) {
    const amount = roundMoney(input.amount);
    if (amount === 0) continue;
    lines.push({
      line_kind: 'monthly_input',
      label: input.pay_element_label || input.label || 'Monthly Input',
      amount,
      source_ref: `monthly_input:${input.id}`,
    });
  }

  for (const expense of expenses) {
    const amount = roundMoney(expense.amount);
    if (amount === 0) continue;
    lines.push({
      line_kind: 'expense',
      label: expense.label || 'Expense',
      amount,
      source_ref: `expense:${expense.id}`,
    });
  }

  for (const loan of loans) {
    const emi = roundMoney(Math.min(loan.emi_amount, loan.outstanding_balance));
    if (emi === 0) continue;
    lines.push({
      line_kind: 'loan',
      label: loan.loan_source === 'pf_temporary' ? 'PF Temporary Recovery' : (loan.label || 'Loan EMI'),
      amount: emi,
      source_ref: `loan:${loan.id}`,
    });
  }

  const absenceAmount = roundMoney(absenceDeductionAmount);
  if (absenceAmount > 0 && absences > 0) {
    const dayLabel = absences === 1 ? '1 day' : `${absences} days`;
    lines.push({
      line_kind: 'absence',
      label: `Absence Deduction (${dayLabel})`,
      amount: absenceAmount,
      source_ref: 'absence_deduction',
    });
  }

  const totals = totalsFromLines(lines);

  return {
    basic_salary: totals.basic_salary,
    present_days: present,
    absent_days: absences,
    lines,
    total_allowances: totals.total_allowances,
    total_deductions: totals.total_deductions,
    total_contributions: totals.total_contributions,
    gross_pay: totals.gross_pay,
    net_pay: totals.net_pay,
  };
}

module.exports = {
  roundMoney,
  calcElementAmount,
  totalsFromLines,
  calculateEmployeePay,
};
