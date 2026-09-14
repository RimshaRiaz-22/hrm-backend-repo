'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseLineManagerIds,
  parseOptionalLineManagerId,
  parseDepartmentManagers,
  wouldCreateLineManagerCycle,
  resolveLineManagerOnDepartmentChange,
  resolveEmployeeManagersOnDepartmentChange,
  buildDepartmentManagersPayload,
} = require('../src/services/lineManager.service');

describe('parseLineManagerIds', () => {
  it('treats undefined as omitted so PATCH can preserve existing mappings', () => {
    const result = parseLineManagerIds(undefined);
    assert.equal(result.omitted, true);
    assert.equal(result.error, undefined);
  });

  it('accepts an empty array to clear mappings', () => {
    const result = parseLineManagerIds([]);
    assert.equal(result.omitted, false);
    assert.deepEqual(result.ids, []);
  });

  it('parses unique positive integers and coerces string numbers', () => {
    const result = parseLineManagerIds(['1', 2, '3']);
    assert.equal(result.omitted, false);
    assert.deepEqual(result.ids, [1, 2, 3]);
  });

  it('rejects non-arrays, non-positive values, and duplicates', () => {
    assert.match(parseLineManagerIds({}).error || '', /array/i);
    assert.match(parseLineManagerIds([0]).error || '', /positive/i);
    assert.match(parseLineManagerIds([-1]).error || '', /positive/i);
    assert.match(parseLineManagerIds([1.5]).error || '', /integer|positive/i);
    assert.match(parseLineManagerIds([1, 1]).error || '', /unique|duplicate/i);
  });
});

describe('parseOptionalLineManagerId', () => {
  it('treats undefined as omitted so PATCH can preserve the current manager', () => {
    const result = parseOptionalLineManagerId(undefined);
    assert.equal(result.omitted, true);
  });

  it('treats null and empty string as an explicit clear', () => {
    assert.deepEqual(parseOptionalLineManagerId(null), { omitted: false, value: null });
    assert.deepEqual(parseOptionalLineManagerId(''), { omitted: false, value: null });
  });

  it('parses a positive integer manager id', () => {
    assert.deepEqual(parseOptionalLineManagerId('42'), { omitted: false, value: 42 });
    assert.deepEqual(parseOptionalLineManagerId(7), { omitted: false, value: 7 });
  });

  it('rejects invalid ids', () => {
    assert.match(parseOptionalLineManagerId(0).error || '', /positive/i);
    assert.match(parseOptionalLineManagerId('abc').error || '', /positive|integer/i);
  });
});

describe('parseDepartmentManagers', () => {
  it('treats undefined fields as omitted', () => {
    assert.equal(parseDepartmentManagers({}).omitted, true);
  });

  it('parses department_head_id', () => {
    const result = parseDepartmentManagers({ department_head_id: '10' });
    assert.equal(result.omitted, false);
    assert.equal(result.departmentHeadId, 10);
    assert.equal(result.primaryManagerId, 10);
    assert.deepEqual(result.additionalManagerIds, []);
  });

  it('clears department head with null', () => {
    const result = parseDepartmentManagers({ department_head_id: null });
    assert.equal(result.omitted, false);
    assert.equal(result.departmentHeadId, null);
  });

  it('accepts legacy primary_manager_id as head', () => {
    const result = parseDepartmentManagers({ primary_manager_id: 5 });
    assert.equal(result.departmentHeadId, 5);
  });

  it('uses first line_manager_ids entry as head', () => {
    const result = parseDepartmentManagers({ line_manager_ids: [7, 8, 9] });
    assert.equal(result.departmentHeadId, 7);
  });
});

describe('buildDepartmentManagersPayload', () => {
  it('maps head role and exposes department_head fields', () => {
    const payload = buildDepartmentManagersPayload([
      {
        id: 10,
        first_name: 'Usama',
        last_name: 'Khan',
        work_email: 'usama@example.com',
        employee_code: 'EMP-001',
        manager_role: 'head',
      },
    ]);
    assert.equal(payload.department_head_id, 10);
    assert.equal(payload.department_head.name, 'Usama Khan');
    assert.equal(payload.primary_manager_id, 10);
    assert.deepEqual(payload.additional_manager_ids, []);
    assert.equal(payload.line_managers[0].role, 'head');
  });

  it('falls back to legacy primary role as head', () => {
    const payload = buildDepartmentManagersPayload([
      {
        id: 11,
        first_name: 'Rimsha',
        last_name: 'Ahmed',
        manager_role: 'primary',
      },
    ]);
    assert.equal(payload.department_head_id, 11);
  });
});

describe('wouldCreateLineManagerCycle', () => {
  it('rejects self-assignment', () => {
    assert.equal(wouldCreateLineManagerCycle(10, 10, new Map()), true);
  });

  it('detects a direct cycle (Usama -> Rimsha -> Usama)', () => {
    const managerByEmployeeId = new Map([[2, 1]]);
    assert.equal(wouldCreateLineManagerCycle(1, 2, managerByEmployeeId), true);
  });

  it('detects a longer cycle (Usama -> Rimsha -> Fatima -> Usama)', () => {
    const managerByEmployeeId = new Map([
      [3, 2],
      [2, 1],
    ]);
    assert.equal(wouldCreateLineManagerCycle(1, 3, managerByEmployeeId), true);
  });

  it('allows a valid Usama -> Rimsha -> Fatima chain', () => {
    const managerByEmployeeId = new Map([[2, 1]]);
    assert.equal(wouldCreateLineManagerCycle(3, 2, managerByEmployeeId), false);
  });

  it('allows clearing / null manager', () => {
    assert.equal(wouldCreateLineManagerCycle(3, null, new Map([[2, 1]])), false);
  });
});

describe('resolveLineManagerOnDepartmentChange', () => {
  it('preserves the manager when still eligible in the new department', () => {
    const result = resolveLineManagerOnDepartmentChange({
      previousLineManagerId: 2,
      lineManagerIdProvided: false,
      requestedLineManagerId: undefined,
      eligibleManagerIds: new Set([2, 5]),
    });
    assert.deepEqual(result, { lineManagerId: 2 });
  });

  it('clears the manager when not eligible after department change and no new manager was supplied', () => {
    const result = resolveLineManagerOnDepartmentChange({
      previousLineManagerId: 2,
      lineManagerIdProvided: false,
      requestedLineManagerId: undefined,
      eligibleManagerIds: new Set([5]),
    });
    assert.deepEqual(result, { lineManagerId: null });
  });

  it('uses an explicitly requested manager when provided', () => {
    const result = resolveLineManagerOnDepartmentChange({
      previousLineManagerId: 2,
      lineManagerIdProvided: true,
      requestedLineManagerId: 5,
      eligibleManagerIds: new Set([5]),
    });
    assert.deepEqual(result, { lineManagerId: 5 });
  });

  it('honors an explicit clear', () => {
    const result = resolveLineManagerOnDepartmentChange({
      previousLineManagerId: 2,
      lineManagerIdProvided: true,
      requestedLineManagerId: null,
      eligibleManagerIds: new Set([2, 5]),
    });
    assert.deepEqual(result, { lineManagerId: null });
  });
});

describe('resolveEmployeeManagersOnDepartmentChange', () => {
  it('keeps only managers still in the eligible set', () => {
    const result = resolveEmployeeManagersOnDepartmentChange({
      previousAssignments: [
        { managerId: 1, role: 'primary' },
        { managerId: 2, role: 'additional' },
      ],
      managersProvided: false,
      eligibleManagerIds: new Set([1]),
    });
    assert.deepEqual(result.assignments, [{ managerId: 1, role: 'primary' }]);
  });
});
