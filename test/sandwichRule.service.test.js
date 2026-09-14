/**
 * Quick sanity checks for sandwich rule pure logic.
 * Run: node test/sandwichRule.service.test.js
 */
const assert = require('assert');
const {
  applySandwichRule,
  classifyPayrollDay,
  summarizePayrollAttendance,
  computeAbsenceDeductionAmount,
} = require('../src/services/sandwichRule.service');

function testSandwichExpansion() {
  const days = [
    { date: '2026-07-03', kind: 'unpaid_absent' }, // Fri
    { date: '2026-07-04', kind: 'bridge' }, // Sat
    { date: '2026-07-05', kind: 'bridge' }, // Sun
    { date: '2026-07-06', kind: 'unpaid_absent' }, // Mon
  ];
  const sandwich = applySandwichRule(days);
  assert.deepStrictEqual([...sandwich].sort(), ['2026-07-04', '2026-07-05']);
}

function testNoSandwichWhenOneSidePresent() {
  const days = [
    { date: '2026-07-03', kind: 'unpaid_absent' },
    { date: '2026-07-04', kind: 'bridge' },
    { date: '2026-07-05', kind: 'bridge' },
    { date: '2026-07-06', kind: 'other' },
  ];
  const sandwich = applySandwichRule(days);
  assert.strictEqual(sandwich.size, 0);
}

function testSummaryWithSandwich() {
  const classifications = [
    classifyPayrollDay({
      dateKey: '2026-07-03',
      workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      attendanceStatus: 'absent',
      todayKey: '2026-07-20',
    }),
    classifyPayrollDay({
      dateKey: '2026-07-04',
      workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      attendanceStatus: 'absent',
      todayKey: '2026-07-20',
    }),
    classifyPayrollDay({
      dateKey: '2026-07-05',
      workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      attendanceStatus: 'absent',
      todayKey: '2026-07-20',
    }),
    classifyPayrollDay({
      dateKey: '2026-07-06',
      workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      attendanceStatus: 'absent',
      todayKey: '2026-07-20',
    }),
  ];

  assert.strictEqual(classifications[0].kind, 'unpaid_absent');
  assert.strictEqual(classifications[1].kind, 'bridge');
  assert.strictEqual(classifications[2].kind, 'bridge');
  assert.strictEqual(classifications[3].kind, 'unpaid_absent');

  const off = summarizePayrollAttendance({
    classifications,
    sandwichRuleEnabled: false,
  });
  assert.strictEqual(off.absent_days, 2);
  assert.strictEqual(off.sandwich_absent_days, 0);

  const on = summarizePayrollAttendance({
    classifications,
    sandwichRuleEnabled: true,
  });
  assert.strictEqual(on.absent_days, 4);
  assert.strictEqual(on.sandwich_absent_days, 2);

  const amount = computeAbsenceDeductionAmount(30000, on.absent_days, 'working_days', on);
  assert.strictEqual(amount, 30000); // capped at basic
}

testSandwichExpansion();
testNoSandwichWhenOneSidePresent();
testSummaryWithSandwich();
console.log('sandwichRule.service.test.js: all passed');
