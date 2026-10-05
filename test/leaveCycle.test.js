const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  computePolicyCycle,
  nextCycleFrom,
  resolveAnchorDate,
} = require('../src/services/leaveCycle.service');

describe('leaveCycle.service', () => {
  it('computes Hamza-style first cycle from joining date', () => {
    const cycle = computePolicyCycle('2025-07-05', '2025-08-01');
    assert.equal(cycle.period_start, '2025-07-05');
    assert.equal(cycle.period_end, '2026-07-04');
    assert.equal(cycle.renewal_date, '2026-07-05');
    assert.equal(cycle.year, 2025);
  });

  it('moves to second cycle on renewal date', () => {
    const cycle = computePolicyCycle('2025-07-05', '2026-07-05');
    assert.equal(cycle.period_start, '2026-07-05');
    assert.equal(cycle.period_end, '2027-07-04');
    assert.equal(cycle.renewal_date, '2027-07-05');
  });

  it('builds next cycle from a closed period', () => {
    const next = nextCycleFrom('2025-07-05', '2025-07-05');
    assert.equal(next.period_start, '2026-07-05');
    assert.equal(next.period_end, '2027-07-04');
    assert.equal(next.renewal_date, '2027-07-05');
  });

  it('resolves anchor join → hire → created', () => {
    assert.equal(
      resolveAnchorDate({ joiningDate: '2025-07-05', hireDate: '2024-01-01', createdAt: '2023-01-01' }),
      '2025-07-05'
    );
    assert.equal(
      resolveAnchorDate({ joiningDate: null, hireDate: '2024-01-01', createdAt: '2023-01-01' }),
      '2024-01-01'
    );
  });
});
