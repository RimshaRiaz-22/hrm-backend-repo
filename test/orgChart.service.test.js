'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePositiveInt,
  buildNodeId,
  mapEmployeeBrief,
} = require('../src/services/orgChart.service');

describe('orgChart.service helpers', () => {
  it('parsePositiveInt accepts positive integers and rejects invalid values', () => {
    assert.equal(parsePositiveInt(5), 5);
    assert.equal(parsePositiveInt('12'), 12);
    assert.equal(parsePositiveInt(0), null);
    assert.equal(parsePositiveInt(-1), null);
    assert.equal(parsePositiveInt('abc'), null);
  });

  it('buildNodeId formats stable tree ids', () => {
    assert.equal(buildNodeId('company', 1), 'company-1');
    assert.equal(buildNodeId('dept', 5), 'dept-5');
    assert.equal(buildNodeId('mgr', 5, 10), 'mgr-5-10');
    assert.equal(buildNodeId('emp', 5, 10, 22), 'emp-5-10-22');
  });

  it('mapEmployeeBrief builds display fields and excludes manager self-reference data shape', () => {
    const mapped = mapEmployeeBrief({
      id: 22,
      first_name: 'Fatima',
      last_name: 'Ali',
      work_email: 'fatima@example.com',
      employee_code: 'EMP-003',
      designation_name: 'Engineer',
    });
    assert.deepEqual(mapped, {
      id: 22,
      name: 'Fatima Ali',
      email: 'fatima@example.com',
      employee_no: 'EMP-003',
      designation: 'Engineer',
    });
  });
});
