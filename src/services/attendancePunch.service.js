const { dateToPgUtcTimestamp, shiftTimeToCompanyLocalMinutes, wallClockMinutesInTimezone } = require('../utils/dateTime');

function normalizePunchAction(value) {
  const action = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (action === 'break_in') return 'break_start';
  if (action === 'break_out') return 'break_end';
  if (action === 'clockin') return 'clock_in';
  if (action === 'clockout') return 'clock_out';
  return action;
}

function normalizePunchRows(rows) {
  return (rows || []).map((row) => ({
    ...row,
    action_type: normalizePunchAction(row.action_type),
  }));
}

function sortPunchTimeline(punches = []) {
  return [...punches].sort((a, b) => {
    const aTime = new Date(a.punched_at).getTime();
    const bTime = new Date(b.punched_at).getTime();
    if (aTime !== bTime) return aTime - bTime;
    return Number(a.id) - Number(b.id);
  });
}

function minutesFromTime(value) {
  if (!value) return null;
  const [hours, minutes] = String(value).slice(0, 5).split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function normalizeWorkingDays(value) {
  if (Array.isArray(value)) return value.map((day) => String(day).toLowerCase());
  if (value && typeof value === 'object') {
    return Object.values(value).map((day) => String(day).toLowerCase());
  }
  return [];
}

function getWeekdayName(attendanceDate) {
  const index = new Date(`${attendanceDate}T00:00:00Z`).getUTCDay();
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][index];
}


function resolveShiftGraceMinutes(row) {
  const attendanceSchedule =
    row?.attendance_schedule && typeof row.attendance_schedule === 'object'
      ? row.attendance_schedule
      : {};
  if (
    row?.working_hours_threshold_minutes !== undefined &&
    row?.working_hours_threshold_minutes !== null &&
    row?.working_hours_threshold_minutes !== ''
  ) {
    return Number(row.working_hours_threshold_minutes);
  }
  if (row?.location_grace_minutes !== undefined && row?.location_grace_minutes !== null) {
    return Number(row.location_grace_minutes);
  }
  if (attendanceSchedule.grace_minutes !== undefined && attendanceSchedule.grace_minutes !== null) {
    return Number(attendanceSchedule.grace_minutes);
  }
  return 0;
}

function minutesFromPunchInTimezone(value, timeZone) {
  return wallClockMinutesInTimezone(value, timeZone || 'UTC');
}

function buildShiftValidation(row, attendanceDate, punchedAt = null) {
  const attendanceSchedule =
    row?.attendance_schedule && typeof row.attendance_schedule === 'object'
      ? row.attendance_schedule
      : {};
  const shiftStart = row?.shift_start || attendanceSchedule.shift_start || row?.location_shift_start;
  const workingDays = normalizeWorkingDays(row?.working_days || attendanceSchedule.working_days);
  const weekday = getWeekdayName(attendanceDate);
  const isWorkingDay = workingDays.length === 0 || workingDays.includes(weekday);
  const graceMinutes = resolveShiftGraceMinutes(row);
  const companyTimezone = row?.company_timezone || 'UTC';

  let lateMinutes = null;
  let punchCompareMinutes = null;
  let shiftStartCompareMinutes = null;
  if (punchedAt && shiftStart) {
    punchCompareMinutes = minutesFromPunchInTimezone(punchedAt, companyTimezone);
    shiftStartCompareMinutes = shiftTimeToCompanyLocalMinutes(shiftStart, companyTimezone);
    lateMinutes =
      punchCompareMinutes !== null && shiftStartCompareMinutes !== null
        ? Math.max(punchCompareMinutes - shiftStartCompareMinutes - graceMinutes, 0)
        : null;
  }

  return {
    is_working_day: isWorkingDay,
    is_late: lateMinutes !== null ? lateMinutes > 0 : null,
    late_minutes: lateMinutes,
  };
}

function deriveClockInStatus(employee, attendanceDate, clockInTimestamp) {
  const shiftValidation = buildShiftValidation(employee, attendanceDate, clockInTimestamp);
  return shiftValidation.is_late === true ? 'late' : 'present';
}

function findLatestClockIn(punches = []) {
  const clockIns = sortPunchTimeline(normalizePunchRows(punches)).filter(
    (punch) => normalizePunchAction(punch.action_type) === 'clock_in'
  );
  return clockIns.length ? clockIns[clockIns.length - 1] : null;
}

function deriveDayAttendanceStatus(employee, attendanceDate, punches = []) {
  if (!employee) return 'absent';
  if (!punches.length) {
    const shiftValidation = buildShiftValidation(employee, attendanceDate);
    return shiftValidation.is_working_day ? 'absent' : 'off_day';
  }

  const attendanceClockIn = findLatestClockIn(punches);
  if (!attendanceClockIn) {
    return 'present';
  }

  const clockInStatus = deriveClockInStatus(employee, attendanceDate, attendanceClockIn.punched_at);
  return clockInStatus === 'late' ? 'late' : 'present';
}

const EMPLOYEE_ATTENDANCE_PROFILE_SQL = `
  SELECT
    e.id,
    e.first_name,
    e.last_name,
    e.employee_code,
    e.work_email,
    e.attendance_schedule,
    e.company_id,
    c.timezone AS company_timezone,
    ejd.work_location_id,
    ejd.department_id,
    d.name AS department_name,
    wl.shift_start AS location_shift_start,
    wl.grace_minutes AS location_grace_minutes,
    ejd.shift_id,
    s.start_time AS shift_start,
    s.working_days,
    s.working_hours_threshold_minutes
  FROM employees e
  LEFT JOIN companies c ON c.id = e.company_id
  LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
  LEFT JOIN departments d ON d.id = ejd.department_id
  LEFT JOIN attendance_location_settings wl ON wl.id = ejd.work_location_id
  LEFT JOIN shifts s ON s.id = ejd.shift_id
`;

async function getCompanyDayAttendanceCounts(client, companyId, attendanceDate, onLeaveEmployeeIds = new Set()) {
  const employeesResult = await client.query(
    `${EMPLOYEE_ATTENDANCE_PROFILE_SQL}
     WHERE e.company_id = $1 AND e.employment_status != 'exited'
     ORDER BY e.id ASC`,
    [companyId]
  );

  const employeeRows = employeesResult.rows;
  const employeeIds = employeeRows.map((row) => Number(row.id));
  const punchesByEmployee = new Map();

  if (employeeIds.length > 0) {
    const punchesResult = await client.query(
      `SELECT id, employee_id, attendance_date, action_type, punched_at, source, marked_by,
              work_location_id, latitude, longitude, remarks, attendance_status, created_at
       FROM attendance_punches
       WHERE employee_id = ANY($1::bigint[])
         AND attendance_date = $2
       ORDER BY created_at DESC, id DESC`,
      [employeeIds, attendanceDate]
    );

    for (const punch of normalizePunchRows(punchesResult.rows)) {
      const employeeId = Number(punch.employee_id);
      if (!punchesByEmployee.has(employeeId)) punchesByEmployee.set(employeeId, []);
      punchesByEmployee.get(employeeId).push(punch);
    }
  }

  const counts = {
    total_employees: employeeRows.length,
    present: 0,
    late: 0,
    absent: 0,
    off_day: 0,
    on_leave: 0,
    checked_in: 0,
  };

  for (const employee of employeeRows) {
    const employeeId = Number(employee.id);
    if (onLeaveEmployeeIds.has(employeeId)) {
      counts.on_leave += 1;
      continue;
    }

    const punches = punchesByEmployee.get(employeeId) || [];
    const status = deriveDayAttendanceStatus(employee, attendanceDate, punches);
    if (status === 'present') {
      counts.present += 1;
      counts.checked_in += 1;
    } else if (status === 'late') {
      counts.late += 1;
      counts.checked_in += 1;
    } else if (status === 'absent') {
      counts.absent += 1;
    } else if (status === 'off_day') {
      counts.off_day += 1;
    }
  }

  return counts;
}

function resolveDepartmentGroup(employee) {
  const departmentId =
    employee.department_id !== undefined && employee.department_id !== null
      ? Number(employee.department_id)
      : null;
  const departmentName =
    employee.department_name !== undefined && employee.department_name !== null
      ? String(employee.department_name).trim()
      : '';
  const key = departmentId ? `dept:${departmentId}` : 'dept:unassigned';
  return {
    key,
    department_id: departmentId,
    label: departmentName || 'Unassigned',
  };
}

async function getCompanyDayAttendanceSnapshot(client, companyId, attendanceDate, onLeaveEmployeeIds = new Set()) {
  const employeesResult = await client.query(
    `${EMPLOYEE_ATTENDANCE_PROFILE_SQL}
     WHERE e.company_id = $1 AND e.employment_status != 'exited'
     ORDER BY e.id ASC`,
    [companyId]
  );

  const employeeRows = employeesResult.rows;
  const employeeIds = employeeRows.map((row) => Number(row.id));
  const punchesByEmployee = new Map();

  if (employeeIds.length > 0) {
    const punchesResult = await client.query(
      `SELECT id, employee_id, attendance_date, action_type, punched_at, source, marked_by,
              work_location_id, latitude, longitude, remarks, attendance_status, created_at
       FROM attendance_punches
       WHERE employee_id = ANY($1::bigint[])
         AND attendance_date = $2
       ORDER BY created_at DESC, id DESC`,
      [employeeIds, attendanceDate]
    );

    for (const punch of normalizePunchRows(punchesResult.rows)) {
      const employeeId = Number(punch.employee_id);
      if (!punchesByEmployee.has(employeeId)) punchesByEmployee.set(employeeId, []);
      punchesByEmployee.get(employeeId).push(punch);
    }
  }

  const counts = {
    total_employees: employeeRows.length,
    present: 0,
    late: 0,
    absent: 0,
    off_day: 0,
    on_leave: 0,
    checked_in: 0,
  };
  const departmentMap = new Map();

  for (const employee of employeeRows) {
    const employeeId = Number(employee.id);
    const department = resolveDepartmentGroup(employee);

    if (!departmentMap.has(department.key)) {
      departmentMap.set(department.key, {
        department_id: department.department_id,
        label: department.label,
        total: 0,
        present: 0,
      });
    }

    const departmentRow = departmentMap.get(department.key);
    departmentRow.total += 1;

    if (onLeaveEmployeeIds.has(employeeId)) {
      counts.on_leave += 1;
      continue;
    }

    const punches = punchesByEmployee.get(employeeId) || [];
    const status = deriveDayAttendanceStatus(employee, attendanceDate, punches);

    if (status === 'present') {
      counts.present += 1;
      counts.checked_in += 1;
      departmentRow.present += 1;
    } else if (status === 'late') {
      counts.late += 1;
      counts.checked_in += 1;
      departmentRow.present += 1;
    } else if (status === 'absent') {
      counts.absent += 1;
    } else if (status === 'off_day') {
      counts.off_day += 1;
    }
  }

  const byDepartment = Array.from(departmentMap.values())
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((row) => ({
      department_id: row.department_id,
      label: row.label,
      value: `${row.present}/${row.total}`,
      present: row.present,
      total: row.total,
    }));

  return { counts, by_department: byDepartment };
}

function buildPunchMetrics(punches) {
  const sessions = [];
  const breaks = [];
  let activeSession = null;
  let activeBreak = null;

  for (const punch of sortPunchTimeline(normalizePunchRows(punches))) {
    const punchedAt = new Date(punch.punched_at);
    const action = normalizePunchAction(punch.action_type);
    if (action === 'clock_in') {
      activeSession = {
        clock_in_time: punch.punched_at,
        clock_out_time: null,
      };
      activeBreak = null;
    } else if (action === 'break_start' && activeSession && !activeBreak) {
      activeBreak = { break_start_time: punch.punched_at };
    } else if (action === 'break_end' && activeBreak) {
      breaks.push(activeBreak);
      activeBreak = null;
    } else if (action === 'clock_out' && activeSession && !activeBreak) {
      activeSession.clock_out_time = punch.punched_at;
      sessions.push(activeSession);
      activeSession = null;
    }
  }

  if (activeSession) sessions.push(activeSession);

  return { sessions, break_sessions: breaks };
}

async function getEmployeeAttendanceProfile(client, employeeId) {
  const result = await client.query(
    `${EMPLOYEE_ATTENDANCE_PROFILE_SQL}
     WHERE e.id = $1`,
    [employeeId]
  );
  return result.rows[0] || null;
}

async function getPunchesForDate(client, employeeId, attendanceDate) {
  const result = await client.query(
    `SELECT id, employee_id, attendance_date, action_type, punched_at, source, marked_by,
            work_location_id, latitude, longitude, remarks, attendance_status, created_at
     FROM attendance_punches
     WHERE employee_id = $1 AND attendance_date = $2
     ORDER BY created_at DESC, id DESC`,
    [employeeId, attendanceDate]
  );
  return normalizePunchRows(result.rows);
}

function snapshotOriginalCheckTimes(punches) {
  const metrics = buildPunchMetrics(punches);
  const firstSession = metrics.sessions[0];
  return {
    original_check_in: firstSession?.clock_in_time || null,
    original_check_out: firstSession?.clock_out_time || null,
  };
}

async function insertCorrectionPunch(client, {
  employeeId,
  attendanceDate,
  actionType,
  punchedAt,
  markedBy,
  requestId,
  attendanceStatus = null,
}) {
  const result = await client.query(
    `INSERT INTO attendance_punches (
       employee_id, attendance_date, action_type, punched_at, source, marked_by,
       work_location_id, latitude, longitude, remarks, attendance_status
     )
     VALUES ($1, $2, $3, $4, 'admin', $5, NULL, NULL, NULL, $6, $7)
     RETURNING id`,
    [
      employeeId,
      attendanceDate,
      actionType,
      dateToPgUtcTimestamp(punchedAt),
      markedBy,
      `attendance_correction_request:${requestId}`,
      attendanceStatus,
    ]
  );
  return result.rows[0];
}

module.exports = {
  deriveClockInStatus,
  deriveDayAttendanceStatus,
  buildPunchMetrics,
  getEmployeeAttendanceProfile,
  getPunchesForDate,
  getCompanyDayAttendanceCounts,
  getCompanyDayAttendanceSnapshot,
  snapshotOriginalCheckTimes,
  insertCorrectionPunch,
};
