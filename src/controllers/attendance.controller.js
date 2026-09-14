const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { parsePagination, buildPaginationMeta } = require('../utils/pagination');
const { toDateKey, toUtcIsoString, parseUtcDateTime, dateToPgUtcTimestamp, localDateAndTimeToUtcInstant, shiftTimeToCompanyLocalMinutes, wallClockMinutesInTimezone, parseRequiredDateInput, parseOptionalDateInput } = require('../utils/dateTime');
const holidayService = require('../services/holiday.service');
const { isApprovedWfhDateForEmployee } = require('../services/wfhRequest.service');

const ALLOWED_STATUS = new Set(['present', 'late', 'absent']);
const PUNCH_ATTENDANCE_STATUSES = new Set(['present', 'late', 'recorded']);
const ALLOWED_WORK_MODE = new Set(['office', 'remote']);
const ALLOWED_APPROVAL_STATUS = new Set(['pending', 'approved', 'rejected']);
const ALLOWED_SOURCE = new Set(['admin', 'employee']);
const PUNCH_ACTIONS = new Set(['clock_in', 'break_start', 'break_end', 'clock_out']);
const ADMIN_ATTENDANCE_ROLES = new Set([
  USER_ROLES.SUPER_ADMIN,
  USER_ROLES.COMPANY_ADMIN,
  USER_ROLES.ADMIN,
  USER_ROLES.HR,
  USER_ROLES.MANAGER,
  USER_ROLES.DEPARTMENT_MANAGER,
]);
const ATTENDANCE_MODES = [
  { key: 'manual', label: 'Manual' },
  { key: 'face', label: 'Face Scan' },
  { key: 'geo_fence', label: 'Geo Fence' },
];
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_GEOFENCE_RADIUS_METERS = 1000;
const AUTO_CLOSE_SESSION_REMARK =
  '[AUTO_CLOSED] Session closed automatically at end of day because clock-out was not recorded.';

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const earthRadiusM = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function getRequestAuth(req) {
  return req.auth || req.authUser || null;
}

function parseRequestLatLng(body, prefix = 'check_in') {
  const latRaw =
    body?.[`${prefix}_latitude`] ??
    body?.[`${prefix}_lat`] ??
    (prefix === 'check_in' ? body?.latitude : undefined);
  const lngRaw =
    body?.[`${prefix}_longitude`] ??
    body?.[`${prefix}_lng`] ??
    (prefix === 'check_in' ? body?.longitude : undefined);

  const hasLat = latRaw !== undefined && latRaw !== null && latRaw !== '';
  const hasLng = lngRaw !== undefined && lngRaw !== null && lngRaw !== '';
  if (!hasLat && !hasLng) return { latitude: null, longitude: null };
  if (hasLat !== hasLng) {
    return { error: `Provide both ${prefix}_latitude and ${prefix}_longitude together, or omit both.` };
  }

  const latitude = Number(latRaw);
  const longitude = Number(lngRaw);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { error: `${prefix}_latitude must be a number between -90 and 90.` };
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { error: `${prefix}_longitude must be a number between -180 and 180.` };
  }
  return { latitude, longitude };
}

async function getEmployeeGeofence(client, employeeId) {
  const workLocationResult = await client.query(
    `SELECT
       wl.id AS work_location_id,
       wl.name AS work_location_name,
       wl.latitude,
       wl.longitude,
       wl.radius_meters,
       wl.address,
       wl.geofencing_enabled
     FROM employee_job_details ejd
     INNER JOIN attendance_location_settings wl
       ON wl.id = ejd.work_location_id
      AND wl.company_id = ejd.company_id
      AND wl.is_active = true
     WHERE ejd.employee_id = $1
     LIMIT 1`,
    [employeeId]
  );
  if (workLocationResult.rowCount > 0) {
    const row = workLocationResult.rows[0];
    return {
      source: 'work_location',
      work_location_id: row.work_location_id,
      name: row.work_location_name,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      radius_meters: Number(row.radius_meters) || DEFAULT_GEOFENCE_RADIUS_METERS,
      address: row.address,
      geofencing_enabled: Boolean(row.geofencing_enabled),
    };
  }

  const settingsResult = await client.query(
    `SELECT latitude, longitude, radius_meters
     FROM attendance_location_settings
     WHERE employee_id = $1`,
    [employeeId]
  );
  if (settingsResult.rowCount === 0) return null;

  const row = settingsResult.rows[0];
  return {
    source: 'attendance_location_settings',
    work_location_id: null,
    name: null,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    radius_meters: Number(row.radius_meters) || DEFAULT_GEOFENCE_RADIUS_METERS,
    address: null,
    geofencing_enabled: true,
  };
}

function formatPunchActionLabel(actionType) {
  const normalizedAction = normalizePunchAction(actionType);
  if (normalizedAction === 'clock_in') return 'clock in';
  if (normalizedAction === 'clock_out') return 'clock out';
  if (normalizedAction === 'break_start') return 'start a break';
  if (normalizedAction === 'break_end') return 'end a break';
  return 'record attendance';
}

async function validateEmployeePunchGeofence(client, employeeId, latitude, longitude, actionType = 'clock_in') {
  const geofence = await getEmployeeGeofence(client, employeeId);
  if (!geofence || !geofence.geofencing_enabled) {
    return { ok: true, geofence, distance_meters: null };
  }
  const actionLabel = formatPunchActionLabel(actionType);
  if (latitude === null || longitude === null) {
    return {
      ok: false,
      status: 400,
      message: `Current latitude and longitude are required to ${actionLabel} for this work location.`,
    };
  }

  const distanceM = haversineDistanceMeters(
    latitude,
    longitude,
    geofence.latitude,
    geofence.longitude
  );
  if (distanceM > geofence.radius_meters) {
    return {
      ok: false,
      status: 403,
      message: `You cannot ${actionLabel} outside the assigned work location radius. Distance: ${Math.round(distanceM)}m, allowed: ${geofence.radius_meters}m.`,
      geofence,
      distance_meters: Number(distanceM.toFixed(2)),
    };
  }

  return {
    ok: true,
    geofence,
    distance_meters: Number(distanceM.toFixed(2)),
  };
}

function buildTimestampFromDateAndTime(date, time, timeZone = 'UTC') {
  return localDateAndTimeToUtcInstant(date, time, timeZone);
}

function extractUtcActionTime(value) {
  const iso = toUtcIsoString(value);
  if (!iso) return null;
  return iso.slice(11, 16);
}

function buildPunchResponseDateTime(punchedAt, attendanceDate) {
  return {
    attendance_date: attendanceDate,
    action_time: extractUtcActionTime(punchedAt),
    punched_at: toUtcIsoString(punchedAt),
  };
}

function calculateWorkHours(checkInTimestamp, checkOutTimestamp) {
  if (!checkInTimestamp || !checkOutTimestamp) {
    return 0;
  }

  const diffMs = checkOutTimestamp.getTime() - checkInTimestamp.getTime();
  if (diffMs <= 0) {
    return null;
  }

  return Number((diffMs / (1000 * 60 * 60)).toFixed(2));
}

function validateDateAndTime(date, time, timeLabel) {
  if (date) {
    const parsed = parseOptionalDateInput(date, 'attendance_date');
    if (parsed.error) return parsed.error;
  }
  if (!time) {
    return `${timeLabel} is required.`;
  }
  const normalizedTime = String(time).trim();
  if (
    !TIME_REGEX.test(normalizedTime) &&
    !/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/.test(normalizedTime)
  ) {
    return `${timeLabel} must be in HH:MM or HH:MM:SS format.`;
  }
  return null;
}

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

async function getAttendanceModes(req, res) {
  return sendSuccess(res, 200, 'Attendance modes fetched successfully.', {
    modes: ATTENDANCE_MODES,
  });
}

async function getAttendanceByEmployeeAndDate(client, employeeId, attendanceDate) {
  return client.query(
    `SELECT id, employee_id, attendance_date, check_in_time, check_out_time, work_hours, status, work_mode,
            approval_status, source, remarks, rejection_reason, approved_by, approved_at, created_at
     FROM attendance
     WHERE employee_id = $1 AND attendance_date = $2`,
    [employeeId, attendanceDate]
  );
}

async function getOpenAttendanceForEmployee(client, employeeId) {
  return client.query(
    `SELECT id, employee_id, attendance_date, check_in_time, check_out_time, work_hours, status, work_mode,
            approval_status, source, remarks, rejection_reason, approved_by, approved_at, created_at
     FROM attendance
     WHERE employee_id = $1 AND check_in_time IS NOT NULL AND check_out_time IS NULL
     ORDER BY attendance_date DESC, id DESC
     LIMIT 1`,
    [employeeId]
  );
}

async function getBreakSessions(client, attendanceId) {
  const result = await client.query(
    `SELECT id, attendance_id, break_in_time, break_out_time, duration_minutes, created_at
     FROM attendance_breaks
     WHERE attendance_id = $1
     ORDER BY break_in_time ASC`,
    [attendanceId]
  );
  return result.rows;
}

function buildAttendanceActionState(attendance, breakSessions) {
  if (!attendance) {
    return {
      can_clock_in: true,
      can_break_in: false,
      can_break_out: false,
      can_clock_out: false,
      next_allowed_action: 'clock_in',
    };
  }

  const hasClockIn = Boolean(attendance.check_in_time);
  const hasClockOut = Boolean(attendance.check_out_time);
  const hasOpenBreak = breakSessions.some((session) => !session.break_out_time);
  const hasAnyBreak = breakSessions.length > 0;

  // Strict single-step flow:
  // clock_in -> break_in -> break_out -> clock_out
  let nextAllowedAction = null;
  if (!hasClockIn) {
    nextAllowedAction = 'clock_in';
  } else if (!hasAnyBreak) {
    nextAllowedAction = 'break_in';
  } else if (hasOpenBreak) {
    nextAllowedAction = 'break_out';
  } else if (!hasClockOut) {
    nextAllowedAction = 'clock_out';
  }

  return {
    can_clock_in: nextAllowedAction === 'clock_in',
    can_break_in: nextAllowedAction === 'break_in',
    can_break_out: nextAllowedAction === 'break_out',
    can_clock_out: nextAllowedAction === 'clock_out',
    next_allowed_action: nextAllowedAction,
  };
}

async function buildAttendanceSnapshot(client, attendanceId) {
  const attendanceResult = await client.query(
    `SELECT id, employee_id, attendance_date, check_in_time, check_out_time, work_hours, status, work_mode,
            approval_status, source, remarks, rejection_reason, approved_by, approved_at, created_at
     FROM attendance
     WHERE id = $1`,
    [attendanceId]
  );

  const attendance = attendanceResult.rows[0] || null;
  const breakSessions = attendance ? await getBreakSessions(client, attendance.id) : [];
  const state = buildAttendanceActionState(attendance, breakSessions);

  return {
    attendance,
    break_sessions: breakSessions,
    state,
  };
}

async function markAttendance(req, res) {
  const hasManualEmployeeField =
    req.body?.employee_name !== undefined ||
    req.body?.employeeName !== undefined ||
    req.body?.name !== undefined;
  if (hasManualEmployeeField) {
    return sendError(
      res,
      400,
      'Use employee_id only. Manual employee name fields are not allowed for attendance.'
    );
  }

  const {
    employee_id,
    attendance_date,
    check_in_time,
    check_out_time,
    status,
    work_mode,
    approval_status = 'approved',
    source = 'admin',
  } = req.body || {};

  let remarks = req.body?.remarks ?? null;

  const parsedEmployeeId = Number(employee_id);
  if (!Number.isInteger(parsedEmployeeId) || parsedEmployeeId <= 0) {
    return sendError(res, 400, 'Please provide a valid employee_id.');
  }

  if (!attendance_date) {
    return sendError(res, 400, 'attendance_date is required.');
  }
  const attendanceDateParsed = parseRequiredDateInput(attendance_date, 'attendance_date');
  if (attendanceDateParsed.error) {
    return sendError(res, 400, attendanceDateParsed.error);
  }
  const normalizedAttendanceDate = attendanceDateParsed.value;

  if (!ALLOWED_STATUS.has(status)) {
    return sendError(res, 400, 'status must be one of: present, late, absent.');
  }

  if (!ALLOWED_WORK_MODE.has(work_mode)) {
    return sendError(res, 400, 'work_mode must be one of: office, remote.');
  }

  if (!ALLOWED_APPROVAL_STATUS.has(approval_status)) {
    return sendError(res, 400, 'approval_status must be one of: pending, approved, rejected.');
  }
  if (check_in_time && !TIME_REGEX.test(check_in_time)) {
    return sendError(res, 400, 'check_in_time must be in HH:MM format.');
  }
  if (check_out_time && !TIME_REGEX.test(check_out_time)) {
    return sendError(res, 400, 'check_out_time must be in HH:MM format.');
  }
  if ((check_in_time && !check_out_time) || (!check_in_time && check_out_time)) {
    return sendError(res, 400, 'Please provide both check_in_time and check_out_time together.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const employeeResult = await client.query(
      'SELECT id, first_name, last_name FROM employees WHERE id = $1',
      [parsedEmployeeId]
    );
    if (employeeResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'Employee not found.');
    }

    const employeeProfile = await getEmployeeAttendanceProfile(client, parsedEmployeeId);
    const companyTimezone = employeeProfile?.company_timezone || 'UTC';

    const parsedCheckIn = buildTimestampFromDateAndTime(normalizedAttendanceDate, check_in_time, companyTimezone);
    const parsedCheckOut = buildTimestampFromDateAndTime(normalizedAttendanceDate, check_out_time, companyTimezone);

    const computedHours = calculateWorkHours(parsedCheckIn, parsedCheckOut);
    if (computedHours === null) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'check_out_time must be later than check_in_time.');
    }

    const latRaw =
      req.body?.check_in_latitude ?? req.body?.check_in_lat ?? req.body?.latitude;
    const lngRaw =
      req.body?.check_in_longitude ?? req.body?.check_in_lng ?? req.body?.longitude;
    let checkInLat = null;
    let checkInLng = null;
    if (latRaw !== undefined && latRaw !== null && latRaw !== '') {
      checkInLat = Number(latRaw);
      if (!Number.isFinite(checkInLat) || checkInLat < -90 || checkInLat > 90) {
        await client.query('ROLLBACK');
        return sendError(res, 400, 'check_in_latitude must be a number between -90 and 90.');
      }
    }
    if (lngRaw !== undefined && lngRaw !== null && lngRaw !== '') {
      checkInLng = Number(lngRaw);
      if (!Number.isFinite(checkInLng) || checkInLng < -180 || checkInLng > 180) {
        await client.query('ROLLBACK');
        return sendError(res, 400, 'check_in_longitude must be a number between -180 and 180.');
      }
    }
    if (
      (checkInLat !== null && checkInLng === null) ||
      (checkInLat === null && checkInLng !== null)
    ) {
      await client.query('ROLLBACK');
      return sendError(
        res,
        400,
        'Provide both check_in_latitude and check_in_longitude together, or omit both.'
      );
    }

    if (work_mode === 'office') {
      const geofence = await getEmployeeGeofence(client, parsedEmployeeId);
      if (!geofence && checkInLat !== null && checkInLng !== null) {
        await client.query('ROLLBACK');
        return sendError(
          res,
          400,
          'No attendance location settings exist for this employee. Admin must save settings via POST /api/v1/attendance/settings before marking with GPS.'
        );
      }
      if (geofence?.geofencing_enabled) {
        if (source === 'employee' && (checkInLat === null || checkInLng === null)) {
          await client.query('ROLLBACK');
          return sendError(res, 400, 'Current latitude and longitude are required to mark office attendance.');
        }
        if (checkInLat !== null && checkInLng !== null) {
          const distanceM = haversineDistanceMeters(
            checkInLat,
            checkInLng,
            geofence.latitude,
            geofence.longitude
          );
          const allowed = geofence.radius_meters || DEFAULT_GEOFENCE_RADIUS_METERS;
          if (distanceM > allowed) {
            if (source === 'employee') {
              await client.query('ROLLBACK');
              return sendError(res, 403, 'You cannot clock in outside the assigned work location radius.', {
                work_location: geofence,
                distance_meters: Number(distanceM.toFixed(2)),
              });
            }
            const invalidNote = `[INVALID_LOCATION] Distance ${Math.round(distanceM)}m (${(distanceM / 1000).toFixed(2)} km) from allotted point; allowed ${allowed}m (${(allowed / 1000).toFixed(2)} km).`;
            if (!remarks) {
              remarks = invalidNote;
            } else if (!String(remarks).includes('[INVALID_LOCATION]')) {
              remarks = `${remarks} ${invalidNote}`;
            }
          }
        }
      }
    }

    const insertResult = await client.query(
      `INSERT INTO attendance
      (
        employee_id,
        attendance_date,
        check_in_time,
        check_out_time,
        work_hours,
        status,
        work_mode,
        approval_status,
        source,
        remarks,
        approved_at,
        check_in_latitude,
        check_in_longitude
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::VARCHAR(20),
        $9,
        $10,
        CASE WHEN $8::VARCHAR(20) = 'approved'::VARCHAR(20) THEN NOW() ELSE NULL END,
        $11,
        $12
      )
      RETURNING id, employee_id, attendance_date, check_in_time, check_out_time, work_hours, status, work_mode, approval_status, source, remarks, approved_at, created_at,
               check_in_latitude, check_in_longitude`,
      [
        parsedEmployeeId,
        normalizedAttendanceDate,
        parsedCheckIn,
        parsedCheckOut,
        computedHours,
        status,
        work_mode,
        approval_status,
        source,
        remarks,
        checkInLat,
        checkInLng,
      ]
    );

    await client.query('COMMIT');
    return sendSuccess(res, 201, 'Attendance marked successfully.', insertResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return sendError(res, 409, 'Attendance already exists for this employee and date.');
    }
    console.error('Mark attendance error:', error);
    return sendError(res, 500, 'Something went wrong while marking attendance.');
  } finally {
    client.release();
  }
}

async function getEmployeeIdFromAuth(auth) {
  const result = await pool.query(
    `SELECT COALESCE(u.employee_id, e.id) AS employee_id
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id OR e.work_email = u.email
     WHERE u.id = $1 AND u.email = $2`,
    [auth.userId, auth.email]
  );

  if (result.rowCount === 0 || !result.rows[0].employee_id) {
    return null;
  }

  return Number(result.rows[0].employee_id);
}

async function markMyAttendance(req, res) {
  const auth = getRequestAuth(req);
  if (!auth) {
    return sendError(res, 401, 'Authorization token is required.');
  }

  try {
    const employeeId = await getEmployeeIdFromAuth(auth);
    if (!employeeId) {
      return sendError(res, 404, 'No employee profile linked to this user.');
    }

    const body = { ...(req.body || {}) };
    const { attendance_date, check_in_time } = body;
    if (attendance_date && check_in_time) {
      const client = await pool.connect();
      try {
        const employee = await getEmployeeAttendanceProfile(client, employeeId);
        if (employee) {
          const checkInTimestamp = buildTimestampFromDateAndTime(
            attendance_date,
            check_in_time,
            employee.company_timezone
          );
          body.status = deriveClockInStatus(employee, attendance_date, checkInTimestamp);
        }
      } finally {
        client.release();
      }
    }

    req.body = {
      ...body,
      employee_id: employeeId,
      approval_status: 'pending',
      source: 'employee',
    };

    const originalMarkAttendance = markAttendance;
    return originalMarkAttendance(req, res);
  } catch (error) {
    console.error('Mark my attendance error:', error);
    return sendError(res, 500, 'Something went wrong while marking your attendance.');
  }
}

async function clockInMyAttendance(req, res) {
  const auth = getRequestAuth(req);
  if (!auth) {
    return sendError(res, 401, 'Authorization token is required.');
  }

  const { attendance_date, clock_in_time, work_mode = 'office', remarks = null } = req.body || {};
  const normalizedAttendanceDate = attendance_date || getTodayDateString();
  const validationError = validateDateAndTime(
    normalizedAttendanceDate,
    clock_in_time,
    'clock_in_time'
  );
  if (validationError) {
    return sendError(res, 400, validationError);
  }
  if (!ALLOWED_WORK_MODE.has(work_mode)) {
    return sendError(res, 400, 'work_mode must be one of: office, remote.');
  }
  const checkInLocation = parseRequestLatLng(req.body || {}, 'check_in');
  if (checkInLocation.error) return sendError(res, 400, checkInLocation.error);

  const client = await pool.connect();
  try {
    const employeeId = await getEmployeeIdFromAuth(auth);
    if (!employeeId) {
      return sendError(res, 404, 'No employee profile linked to this user.');
    }

    const employeeProfile = await getEmployeeAttendanceProfile(client, employeeId);
    if (!employeeProfile) {
      return sendError(res, 404, 'Employee not found.');
    }

    const punchAssignment = buildPunchAssignment(employeeProfile);
    if (!punchAssignment.can_punch) {
      return sendError(res, 400, punchAssignment.message, {
        punch_assignment: punchAssignment,
      });
    }

    const clockInTimestamp = buildTimestampFromDateAndTime(
      normalizedAttendanceDate,
      clock_in_time,
      employeeProfile.company_timezone
    );
    const status = deriveClockInStatus(
      employeeProfile,
      normalizedAttendanceDate,
      clockInTimestamp
    );

    await client.query('BEGIN');
    const isWfhDay = await isApprovedWfhDateForEmployee(
      client,
      employeeId,
      normalizedAttendanceDate
    );
    const geofenceCheck =
      work_mode === 'office' && !isWfhDay
        ? await validateEmployeePunchGeofence(
            client,
            employeeId,
            checkInLocation.latitude,
            checkInLocation.longitude
          )
        : { ok: true, geofence: null, distance_meters: null };
    if (!geofenceCheck.ok) {
      await client.query('ROLLBACK');
      return sendError(res, geofenceCheck.status, geofenceCheck.message, {
        work_location: geofenceCheck.geofence,
        distance_meters: geofenceCheck.distance_meters,
      });
    }

    const attendanceResult = await getAttendanceByEmployeeAndDate(
      client,
      employeeId,
      normalizedAttendanceDate
    );

    let attendanceId;
    if (attendanceResult.rowCount === 0) {
      const inserted = await client.query(
        `INSERT INTO attendance
         (employee_id, attendance_date, check_in_time, check_out_time, work_hours, status, work_mode,
          approval_status, source, remarks, check_in_latitude, check_in_longitude, work_location_id)
         VALUES ($1, $2, $3, NULL, 0, $4, $5, 'pending', 'employee', $6, $7, $8, $9)
         RETURNING id`,
        [
          employeeId,
          normalizedAttendanceDate,
          clockInTimestamp,
          status,
          work_mode,
          remarks,
          checkInLocation.latitude,
          checkInLocation.longitude,
          geofenceCheck.geofence?.work_location_id ?? null,
        ]
      );
      attendanceId = inserted.rows[0].id;
    } else {
      const existing = attendanceResult.rows[0];
      const existingBreaks = await getBreakSessions(client, existing.id);
      const currentState = buildAttendanceActionState(existing, existingBreaks);
      if (currentState.next_allowed_action !== 'clock_in') {
        await client.query('ROLLBACK');
        return sendError(
          res,
          409,
          `Action not allowed. Next allowed action is ${currentState.next_allowed_action || 'none'}.`
        );
      }
      if (existing.check_in_time) {
        const snapshot = await buildAttendanceSnapshot(client, existing.id);
        await client.query('COMMIT');
        return sendSuccess(res, 200, 'You are already clocked in for this date.', snapshot);
      }
      await client.query(
        `UPDATE attendance
         SET check_in_time = $1, status = $2, work_mode = $3, approval_status = 'pending', source = 'employee',
             remarks = COALESCE($4, remarks),
             check_in_latitude = $5,
             check_in_longitude = $6,
             work_location_id = $7
         WHERE id = $8`,
        [
          clockInTimestamp,
          status,
          work_mode,
          remarks,
          checkInLocation.latitude,
          checkInLocation.longitude,
          geofenceCheck.geofence?.work_location_id ?? null,
          existing.id,
        ]
      );
      attendanceId = existing.id;
    }

    const snapshot = await buildAttendanceSnapshot(client, attendanceId);
    await client.query('COMMIT');
    return sendSuccess(res, 200, 'Clock in recorded successfully.', snapshot);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Clock in error:', error);
    return sendError(res, 500, 'Something went wrong while recording clock in.');
  } finally {
    client.release();
  }
}

async function breakInMyAttendance(req, res) {
  const auth = getRequestAuth(req);
  if (!auth) {
    return sendError(res, 401, 'Authorization token is required.');
  }

  const { attendance_date, break_in_time } = req.body || {};
  const normalizedAttendanceDate = attendance_date || null;
  const validationError = validateDateAndTime(
    normalizedAttendanceDate || getTodayDateString(),
    break_in_time,
    'break_in_time'
  );
  if (validationError) {
    return sendError(res, 400, validationError);
  }

  const client = await pool.connect();
  try {
    const employeeId = await getEmployeeIdFromAuth(auth);
    if (!employeeId) {
      return sendError(res, 404, 'No employee profile linked to this user.');
    }

    const employeeProfile = await getEmployeeAttendanceProfile(client, employeeId);

    await client.query('BEGIN');
    const attendanceResult = normalizedAttendanceDate
      ? await getAttendanceByEmployeeAndDate(client, employeeId, normalizedAttendanceDate)
      : await getOpenAttendanceForEmployee(client, employeeId);
    if (attendanceResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'You must clock in before starting a break.');
    }

    const attendance = attendanceResult.rows[0];
    const breakSessions = await getBreakSessions(client, attendance.id);
    const currentState = buildAttendanceActionState(attendance, breakSessions);
    if (currentState.next_allowed_action !== 'break_in') {
      await client.query('ROLLBACK');
      return sendError(
        res,
        409,
        `Action not allowed. Next allowed action is ${currentState.next_allowed_action || 'none'}.`
      );
    }
    if (!attendance.check_in_time) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'You must clock in before starting a break.');
    }
    if (attendance.check_out_time) {
      await client.query('ROLLBACK');
      return sendError(res, 409, 'You are already clocked out for this date.');
    }

    const openBreakResult = await client.query(
      `SELECT id FROM attendance_breaks
       WHERE attendance_id = $1 AND break_out_time IS NULL
       ORDER BY break_in_time DESC
       LIMIT 1`,
      [attendance.id]
    );
    if (openBreakResult.rowCount > 0) {
      await client.query('ROLLBACK');
      return sendError(res, 409, 'You are already on break. Please break out first.');
    }

    const breakInTimestamp = buildTimestampFromDateAndTime(
      attendance.attendance_date,
      break_in_time,
      employeeProfile?.company_timezone
    );
    await client.query(
      `INSERT INTO attendance_breaks (attendance_id, break_in_time, break_out_time, duration_minutes)
       VALUES ($1, $2, NULL, 0)`,
      [attendance.id, breakInTimestamp]
    );

    const snapshot = await buildAttendanceSnapshot(client, attendance.id);
    await client.query('COMMIT');
    return sendSuccess(res, 200, 'Break in recorded successfully.', snapshot);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Break in error:', error);
    return sendError(res, 500, 'Something went wrong while recording break in.');
  } finally {
    client.release();
  }
}

async function breakOutMyAttendance(req, res) {
  const auth = getRequestAuth(req);
  if (!auth) {
    return sendError(res, 401, 'Authorization token is required.');
  }

  const { attendance_date, break_out_time } = req.body || {};
  const normalizedAttendanceDate = attendance_date || null;
  const validationError = validateDateAndTime(
    normalizedAttendanceDate || getTodayDateString(),
    break_out_time,
    'break_out_time'
  );
  if (validationError) {
    return sendError(res, 400, validationError);
  }

  const client = await pool.connect();
  try {
    const employeeId = await getEmployeeIdFromAuth(auth);
    if (!employeeId) {
      return sendError(res, 404, 'No employee profile linked to this user.');
    }

    const employeeProfile = await getEmployeeAttendanceProfile(client, employeeId);

    await client.query('BEGIN');
    const attendanceResult = normalizedAttendanceDate
      ? await getAttendanceByEmployeeAndDate(client, employeeId, normalizedAttendanceDate)
      : await getOpenAttendanceForEmployee(client, employeeId);
    if (attendanceResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'No attendance found for this date.');
    }

    const attendance = attendanceResult.rows[0];
    const existingBreaks = await getBreakSessions(client, attendance.id);
    const currentState = buildAttendanceActionState(attendance, existingBreaks);
    if (currentState.next_allowed_action !== 'break_out') {
      await client.query('ROLLBACK');
      return sendError(
        res,
        409,
        `Action not allowed. Next allowed action is ${currentState.next_allowed_action || 'none'}.`
      );
    }
    const openBreakResult = await client.query(
      `SELECT id, break_in_time
       FROM attendance_breaks
       WHERE attendance_id = $1 AND break_out_time IS NULL
       ORDER BY break_in_time DESC
       LIMIT 1`,
      [attendance.id]
    );
    if (openBreakResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 409, 'No active break found to break out.');
    }

    const openBreak = openBreakResult.rows[0];
    const breakOutTimestamp = buildTimestampFromDateAndTime(
      attendance.attendance_date,
      break_out_time,
      employeeProfile?.company_timezone
    );
    const durationMinutes = Math.floor(
      (breakOutTimestamp.getTime() - new Date(openBreak.break_in_time).getTime()) / (1000 * 60)
    );
    if (durationMinutes < 0) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'break_out_time must be later than break_in_time.');
    }

    await client.query(
      `UPDATE attendance_breaks
       SET break_out_time = $1, duration_minutes = $2
       WHERE id = $3`,
      [breakOutTimestamp, durationMinutes, openBreak.id]
    );

    const snapshot = await buildAttendanceSnapshot(client, attendance.id);
    await client.query('COMMIT');
    return sendSuccess(res, 200, 'Break out recorded successfully.', snapshot);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Break out error:', error);
    return sendError(res, 500, 'Something went wrong while recording break out.');
  } finally {
    client.release();
  }
}

async function clockOutMyAttendance(req, res) {
  const auth = getRequestAuth(req);
  if (!auth) {
    return sendError(res, 401, 'Authorization token is required.');
  }

  const { attendance_date, clock_out_time } = req.body || {};
  const normalizedAttendanceDate = attendance_date || null;
  const validationError = validateDateAndTime(
    normalizedAttendanceDate || getTodayDateString(),
    clock_out_time,
    'clock_out_time'
  );
  if (validationError) {
    return sendError(res, 400, validationError);
  }

  const client = await pool.connect();
  try {
    const employeeId = await getEmployeeIdFromAuth(auth);
    if (!employeeId) {
      return sendError(res, 404, 'No employee profile linked to this user.');
    }

    const employeeProfile = await getEmployeeAttendanceProfile(client, employeeId);

    await client.query('BEGIN');
    const attendanceResult = normalizedAttendanceDate
      ? await getAttendanceByEmployeeAndDate(client, employeeId, normalizedAttendanceDate)
      : await getOpenAttendanceForEmployee(client, employeeId);
    if (attendanceResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'You must clock in before clocking out.');
    }

    const attendance = attendanceResult.rows[0];
    const existingBreaks = await getBreakSessions(client, attendance.id);
    const currentState = buildAttendanceActionState(attendance, existingBreaks);
    if (currentState.next_allowed_action !== 'clock_out') {
      await client.query('ROLLBACK');
      return sendError(
        res,
        409,
        `Action not allowed. Next allowed action is ${currentState.next_allowed_action || 'none'}.`
      );
    }
    if (!attendance.check_in_time) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'You must clock in before clocking out.');
    }
    if (attendance.check_out_time) {
      await client.query('ROLLBACK');
      return sendError(res, 409, 'You are already clocked out for this date.');
    }

    const openBreakResult = await client.query(
      `SELECT id
       FROM attendance_breaks
       WHERE attendance_id = $1 AND break_out_time IS NULL
       LIMIT 1`,
      [attendance.id]
    );
    const clockOutTimestamp = buildTimestampFromDateAndTime(
      attendance.attendance_date,
      clock_out_time,
      employeeProfile?.company_timezone
    );
    const clockInTimestamp = new Date(attendance.check_in_time);
    if (openBreakResult.rowCount > 0) {
      await client.query('ROLLBACK');
      return sendError(res, 409, 'Please break out before clocking out.');
    }

    if (clockOutTimestamp.getTime() <= clockInTimestamp.getTime()) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'clock_out_time must be later than clock_in_time.');
    }

    const breakDurationResult = await client.query(
      `SELECT COALESCE(SUM(duration_minutes), 0)::int AS total_break_minutes
       FROM attendance_breaks
       WHERE attendance_id = $1`,
      [attendance.id]
    );
    const totalBreakMinutes = breakDurationResult.rows[0].total_break_minutes || 0;
    const grossMinutes = Math.floor((clockOutTimestamp.getTime() - clockInTimestamp.getTime()) / (1000 * 60));
    const netMinutes = Math.max(grossMinutes - totalBreakMinutes, 0);
    const workHours = Number((netMinutes / 60).toFixed(2));

    await client.query(
      `UPDATE attendance
       SET check_out_time = $1, work_hours = $2
       WHERE id = $3`,
      [clockOutTimestamp, workHours, attendance.id]
    );

    const snapshot = await buildAttendanceSnapshot(client, attendance.id);
    await client.query('COMMIT');
    return sendSuccess(res, 200, 'Clock out recorded successfully.', {
      ...snapshot,
      totals: {
        total_break_minutes: totalBreakMinutes,
        work_hours: workHours,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Clock out error:', error);
    return sendError(res, 500, 'Something went wrong while recording clock out.');
  } finally {
    client.release();
  }
}

async function getMyTodayAttendanceStatus(req, res) {
  const auth = getRequestAuth(req);
  if (!auth) {
    return sendError(res, 401, 'Authorization token is required.');
  }

  const attendanceDateParsed = parseRequiredDateInput(
    req.query?.attendance_date || getTodayDateString(),
    'attendance_date'
  );
  if (attendanceDateParsed.error) {
    return sendError(res, 400, attendanceDateParsed.error);
  }
  const attendanceDate = attendanceDateParsed.value;

  const client = await pool.connect();
  try {
    const employeeId = await getEmployeeIdFromAuth(auth);
    if (!employeeId) {
      return sendError(res, 404, 'No employee profile linked to this user.');
    }

    const attendanceResult = await getAttendanceByEmployeeAndDate(client, employeeId, attendanceDate);
    if (attendanceResult.rowCount === 0) {
      const state = buildAttendanceActionState(null, []);
      return sendSuccess(res, 200, 'Today attendance status fetched successfully.', {
        attendance: null,
        break_sessions: [],
        state,
      });
    }

    const snapshot = await buildAttendanceSnapshot(client, attendanceResult.rows[0].id);
    return sendSuccess(res, 200, 'Today attendance status fetched successfully.', snapshot);
  } catch (error) {
    console.error('Get today attendance status error:', error);
    return sendError(res, 500, 'Something went wrong while fetching today attendance status.');
  } finally {
    client.release();
  }
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

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

function minutesFromTime(value) {
  if (!value) return null;
  const [hours, minutes] = String(value).slice(0, 5).split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function durationMinutesBetweenTimes(start, end) {
  const startMinutes = minutesFromTime(start);
  const endMinutes = minutesFromTime(end);
  if (startMinutes === null || endMinutes === null) return 0;
  return endMinutes >= startMinutes ? endMinutes - startMinutes : endMinutes + 1440 - startMinutes;
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

/**
 * Minutes since midnight on the company-local wall clock for a true UTC instant.
 */
function minutesFromPunchInTimezone(value, timeZone) {
  return wallClockMinutesInTimezone(value, timeZone || 'UTC');
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

function hasAssignedShift(employee) {
  return employee?.shift_id != null && Number(employee.shift_id) > 0;
}

function hasAssignedWorkLocation(employee) {
  return employee?.work_location_id != null && Number(employee.work_location_id) > 0;
}

/** Require shift + work location before any punch (employee or company admin). */
function getEmployeePunchAssignmentError(employee) {
  const hasShift = hasAssignedShift(employee);
  const hasWorkLocation = hasAssignedWorkLocation(employee);

  if (!hasShift && !hasWorkLocation) {
    return 'Employee must be assigned a shift and work location before punching.';
  }
  if (!hasShift) {
    return 'Employee must be assigned a shift before punching.';
  }
  if (!hasWorkLocation) {
    return 'Employee must be assigned a work location before punching.';
  }
  return null;
}

function buildPunchAssignment(employee) {
  const message = getEmployeePunchAssignmentError(employee);
  return {
    can_punch: !message,
    has_shift: hasAssignedShift(employee),
    has_work_location: hasAssignedWorkLocation(employee),
    message,
  };
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

  const assignmentError = getEmployeePunchAssignmentError(row);

  return {
    is_valid: !assignmentError && isWorkingDay,
    reason: assignmentError
      ? assignmentError
      : !isWorkingDay
        ? `Shift is not scheduled for ${weekday}.`
        : null,
    weekday,
    working_days: workingDays,
    is_working_day: isWorkingDay,
    company_timezone: companyTimezone,
    working_hours_threshold_minutes: graceMinutes,
    grace_minutes: graceMinutes,
    shift_start_compare_minutes: shiftStartCompareMinutes,
    punch_compare_minutes: punchCompareMinutes,
    is_late: lateMinutes !== null ? lateMinutes > 0 : null,
    late_minutes: lateMinutes,
  };
}

function findLatestClockIn(punches = []) {
  const timeline = sortPunchTimeline(normalizePunchRows(punches));
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (normalizePunchAction(timeline[index].action_type) === 'clock_in') {
      return timeline[index];
    }
  }
  return null;
}

function getStoredPunchAttendanceStatus(punch) {
  const stored = String(punch?.attendance_status || '')
    .trim()
    .toLowerCase();
  return PUNCH_ATTENDANCE_STATUSES.has(stored) ? stored : null;
}

function deriveClockInStatus(employee, attendanceDate, clockInTimestamp) {
  const shiftValidation = buildShiftValidation(employee, attendanceDate, clockInTimestamp);
  return shiftValidation.is_late === true ? 'late' : 'present';
}

function derivePunchDisplayStatus(punch, employee, attendanceDate) {
  const action = normalizePunchAction(punch.action_type);
  if (action === 'clock_in') {
    return deriveClockInStatus(employee, attendanceDate, punch.punched_at);
  }
  if (action === 'break_start' || action === 'break_end' || action === 'clock_out') {
    return 'recorded';
  }
  return null;
}

/** Prefer status frozen at punch time; recompute only for legacy rows without attendance_status. */
function resolvePunchAttendanceStatus(punch, employee, attendanceDate) {
  const stored = getStoredPunchAttendanceStatus(punch);
  if (stored) return stored;
  return derivePunchDisplayStatus(punch, employee, attendanceDate);
}

function alignShiftValidationWithStoredClockIn(shiftValidation, clockInPunch) {
  const stored = getStoredPunchAttendanceStatus(clockInPunch);
  if (!stored || (stored !== 'present' && stored !== 'late')) {
    return shiftValidation;
  }
  return {
    ...shiftValidation,
    is_late: stored === 'late',
    late_minutes: stored === 'late' ? shiftValidation.late_minutes : 0,
  };
}

function deriveDayAttendanceStatus(employee, attendanceDate, punches = []) {
  if (!punches.length) {
    const shiftValidation = buildShiftValidation(employee, attendanceDate);
    return shiftValidation.is_working_day ? 'absent' : 'off_day';
  }

  const attendanceClockIn = findLatestClockIn(punches);
  if (!attendanceClockIn) {
    return 'present';
  }

  const clockInStatus = resolvePunchAttendanceStatus(
    attendanceClockIn,
    employee,
    attendanceDate
  );
  return clockInStatus === 'late' ? 'late' : 'present';
}

function resolveAttendanceStatusForAction(actionType, employee, attendanceDate, punchedAt) {
  const action = normalizePunchAction(actionType);
  if (action === 'clock_in') {
    return deriveClockInStatus(employee, attendanceDate, punchedAt);
  }
  if (action === 'break_start' || action === 'break_end' || action === 'clock_out') {
    return 'recorded';
  }
  return null;
}

function parsePunchDateTime(body = {}, fallbackAttendanceDate = null, timeZone = 'UTC') {
  const actionTimeRaw = body.action_time ?? body.punch_time ?? body.time;
  const hasActionTime =
    actionTimeRaw !== undefined && actionTimeRaw !== null && String(actionTimeRaw).trim() !== '';

  const punchedAtRaw = body.punched_at ?? body.punchedAt;
  let dateFromPunchedAt = null;
  if (punchedAtRaw) {
    const parsedPunchedAt = parseUtcDateTime(punchedAtRaw);
    if (!parsedPunchedAt) {
      return { error: 'punched_at must be a valid ISO date/time.' };
    }
    dateFromPunchedAt = parsedPunchedAt.toISOString().slice(0, 10);
  }

  const attendanceDateRaw = String(
    body.attendance_date || body.date || fallbackAttendanceDate || dateFromPunchedAt || getTodayDateString()
  ).trim();
  const attendanceDateParsed = parseRequiredDateInput(attendanceDateRaw, 'attendance_date');
  if (attendanceDateParsed.error) {
    return { error: attendanceDateParsed.error };
  }
  const attendanceDate = attendanceDateParsed.value;

  // action_time wins over punched_at when both are sent
  if (hasActionTime) {
    const actionTime = String(actionTimeRaw).trim();
    const timeValidation = validateDateAndTime(null, actionTime, 'action_time');
    if (timeValidation) {
      return { error: timeValidation };
    }
    const punchedAt = buildTimestampFromDateAndTime(attendanceDate, actionTime, timeZone);
    if (!punchedAt || Number.isNaN(punchedAt.getTime())) {
      return { error: 'Unable to build a valid punch timestamp from attendance_date and action_time.' };
    }
    return {
      attendanceDate,
      actionTime: extractUtcActionTime(punchedAt),
      punchedAt,
    };
  }

  if (punchedAtRaw) {
    const parsedPunchedAt = parseUtcDateTime(punchedAtRaw);
    if (!parsedPunchedAt) {
      return { error: 'punched_at must be a valid ISO date/time.' };
    }
    return {
      attendanceDate,
      actionTime: extractUtcActionTime(parsedPunchedAt),
      punchedAt: parsedPunchedAt,
    };
  }

  const now = new Date();
  return {
    attendanceDate,
    actionTime: extractUtcActionTime(now),
    punchedAt: now,
  };
}

function extractLocation(body = {}) {
  const parsed = parseRequestLatLng(body, 'check_in');
  if (!parsed.error && (parsed.latitude !== null || parsed.longitude !== null)) return parsed;
  return parseRequestLatLng(body, 'location');
}

function formatPunchRow(punch) {
  if (!punch) return null;
  const attendanceDate = toDateKey(punch.attendance_date) || punch.attendance_date;
  const punchedAtUtc = toUtcIsoString(punch.punched_at);
  return {
    id: Number(punch.id),
    employee_id: Number(punch.employee_id),
    attendance_date: attendanceDate,
    action_time: extractUtcActionTime(punch.punched_at),
    action_type: punch.action_type,
    punched_at: punchedAtUtc,
    source: punch.source,
    marked_by: punch.marked_by != null ? Number(punch.marked_by) : null,
    work_location_id: punch.work_location_id != null ? Number(punch.work_location_id) : null,
    latitude: punch.latitude != null ? Number(punch.latitude) : null,
    longitude: punch.longitude != null ? Number(punch.longitude) : null,
    remarks: punch.remarks ?? null,
    created_at: toUtcIsoString(punch.created_at) ?? punch.created_at,
  };
}

function formatPunchRowWithAttendanceStatus(punch, employee, attendanceDate) {
  const row = formatPunchRow(punch);
  if (!row || !employee) return row;

  const status = resolvePunchAttendanceStatus(punch, employee, attendanceDate);
  if (status) row.status = status;
  return row;
}

function enrichSessionsWithAttendanceStatus(sessions, employee, attendanceDate, punches = []) {
  if (!employee || !Array.isArray(sessions)) return sessions;

  const punchById = new Map(punches.map((punch) => [Number(punch.id), punch]));

  return sessions.map((session) => {
    if (!session?.clock_in_time) return session;
    const clockInPunch = punchById.get(Number(session.clock_in_punch_id));
    const status = clockInPunch
      ? resolvePunchAttendanceStatus(clockInPunch, employee, attendanceDate)
      : deriveClockInStatus(employee, attendanceDate, session.clock_in_time);
    return {
      ...session,
      status: status === 'late' ? 'late' : 'present',
    };
  });
}

function enrichPunchesWithSessionMetrics(punches = [], sessions = [], breakSessions = []) {
  const sessionByClockOut = new Map();
  for (const session of sessions) {
    if (session?.clock_out_punch_id) {
      sessionByClockOut.set(Number(session.clock_out_punch_id), session);
    }
  }
  const breakByEnd = new Map();
  for (const breakSession of breakSessions) {
    if (breakSession?.break_end_punch_id) {
      breakByEnd.set(Number(breakSession.break_end_punch_id), breakSession);
    }
  }

  return punches.map((punch) => {
    const action = normalizePunchAction(punch.action_type);
    if (action === 'clock_out') {
      const session = sessionByClockOut.get(Number(punch.id));
      if (session) {
        return {
          ...punch,
          work_minutes: session.work_minutes,
          work_hours: session.work_hours,
        };
      }
    }
    if (action === 'break_end') {
      const breakSession = breakByEnd.get(Number(punch.id));
      if (breakSession) {
        const breakMinutes = breakSession.duration_minutes;
        return {
          ...punch,
          break_minutes: breakMinutes,
          break_hours:
            breakMinutes != null ? Number((Number(breakMinutes) / 60).toFixed(2)) : null,
          duration_minutes: breakMinutes,
        };
      }
    }
    return punch;
  });
}

function serializeSessionTimestamps(session) {
  if (!session || typeof session !== 'object') return session;
  return {
    ...session,
    clock_in_time: session.clock_in_time ? toUtcIsoString(session.clock_in_time) : session.clock_in_time,
    clock_out_time: session.clock_out_time ? toUtcIsoString(session.clock_out_time) : session.clock_out_time,
    break_start_time: session.break_start_time
      ? toUtcIsoString(session.break_start_time)
      : session.break_start_time,
    break_end_time: session.break_end_time
      ? toUtcIsoString(session.break_end_time)
      : session.break_end_time,
  };
}

function applyAttendancePresentationToDetails(details, employee, attendanceDate, punches, options = {}) {
  if (!details || !employee) return details;

  const dateKey = details.attendance_date || attendanceDate;
  const dayPunches = punches || [];
  const sortOrder = options.sortOrder === 'asc' ? 'asc' : 'desc';
  const status = deriveDayAttendanceStatus(employee, dateKey, dayPunches);
  const enrichedPunches = sortPunchesForDisplay(
    dayPunches.map((punch) => formatPunchRowWithAttendanceStatus(punch, employee, dateKey)),
    sortOrder
  );
  const enrichedSessions = enrichSessionsWithAttendanceStatus(
    details.sessions || [],
    employee,
    dateKey,
    dayPunches
  );
  const enrichedPunchesWithMetrics = enrichPunchesWithSessionMetrics(
    enrichedPunches,
    enrichedSessions,
    details.break_sessions || []
  );
  const lastRaw = findLatestClockIn(dayPunches) || sortPunchTimeline(dayPunches).slice(-1)[0];
  const enrichedState = details.state
    ? {
        ...details.state,
        last_punch: lastRaw
          ? formatPunchRowWithAttendanceStatus(lastRaw, employee, dateKey)
          : details.state.last_punch,
      }
    : details.state;

  return {
    employee: details.employee,
    attendance_date: details.attendance_date,
    status,
    sort: sortOrder,
    punch_id: details.punch_id,
    latest_punch_id: details.latest_punch_id,
    assigned_shift: details.assigned_shift,
    scheduled_work_minutes: details.scheduled_work_minutes,
    scheduled_work_hours: details.scheduled_work_hours,
    scheduled_break_minutes: details.scheduled_break_minutes,
    scheduled_break_hours: details.scheduled_break_hours,
    shift_start: details.shift_start,
    shift_end: details.shift_end,
    work_location: details.work_location,
    punch_assignment: details.punch_assignment || buildPunchAssignment(employee),
    schedule_validation: {
      ...(details.schedule_validation || {}),
      attendance_status: status,
    },
    actual_work_minutes: details.actual_work_minutes,
    actual_work_hours: details.actual_work_hours,
    actual_break_minutes: details.actual_break_minutes,
    actual_break_hours: details.actual_break_hours,
    punches: enrichedPunchesWithMetrics,
    sessions: enrichedSessions.map(serializeSessionTimestamps),
    break_sessions: (details.break_sessions || []).map(serializeSessionTimestamps),
    state: enrichedState,
  };
}

function normalizePunchRows(rows) {
  return rows.map((row) => ({
    ...row,
    action_type: normalizePunchAction(row.action_type),
  }));
}

function sortPunchTimeline(punches = []) {
  return [...punches].sort((a, b) => {
    const aTime = new Date(a.punched_at).getTime();
    const bTime = new Date(b.punched_at).getTime();
    if (aTime !== bTime) return aTime - bTime;
    return Number(a.id || 0) - Number(b.id || 0);
  });
}

function punchCreatedAtMs(punch) {
  if (!punch) return 0;
  const created = punch.created_at != null ? new Date(punch.created_at).getTime() : NaN;
  if (Number.isFinite(created)) return created;
  const punched = punch.punched_at != null ? new Date(punch.punched_at).getTime() : NaN;
  if (Number.isFinite(punched)) return punched;
  return Number(punch.id || 0);
}

function findLatestPunchByCreatedAt(punches = []) {
  if (!punches.length) return null;
  return [...punches].sort((a, b) => punchCreatedAtMs(b) - punchCreatedAtMs(a))[0];
}

function getLatestCreatedAtFromPunches(punches = []) {
  if (!punches.length) return 0;
  return Math.max(...punches.map((punch) => punchCreatedAtMs(punch)));
}

function getLatestCreatedAtFromCalendarRecords(records = []) {
  let max = 0;
  for (const record of records) {
    max = Math.max(max, getLatestCreatedAtFromPunches(record.punches || []));
  }
  return max;
}

function sortCompanyAttendanceLogsByCreatedAt(logs = [], sortOrder = 'desc') {
  const direction = sortOrder === 'asc' ? 'asc' : 'desc';
  return [...logs].sort((a, b) => {
    const aTime = getLatestCreatedAtFromPunches(a.punches || []);
    const bTime = getLatestCreatedAtFromPunches(b.punches || []);
    if (aTime !== bTime) {
      return direction === 'asc' ? aTime - bTime : bTime - aTime;
    }
    const aName = String(a.employee?.name || '');
    const bName = String(b.employee?.name || '');
    return aName.localeCompare(bName);
  });
}

const COMPANY_TODAY_LOGS_SORT_FIELDS = new Set([
  'employee_name',
  'clock_in',
  'start_break',
  'end_break',
  'clock_out',
]);

function getLatestPunchedAtForAction(punches = [], actionType) {
  const target = normalizePunchAction(actionType);
  let latest = 0;
  for (const punch of normalizePunchRows(punches)) {
    if (normalizePunchAction(punch.action_type) !== target) continue;
    const ms = punchCreatedAtMs(punch);
    if (ms > latest) latest = ms;
  }
  return latest;
}

function sortCompanyTodayLogs(logs = [], sortBy = 'employee_name', sortOrder = 'asc') {
  const direction = sortOrder === 'asc' ? 1 : -1;
  const mul = (value) => (value === 0 ? 0 : value > 0 ? 1 : -1);

  return [...logs].sort((a, b) => {
    if (sortBy === 'employee_name') {
      const nameCmp = String(a.employee?.name || '').localeCompare(
        String(b.employee?.name || ''),
      );
      if (nameCmp !== 0) return nameCmp * direction;
      return (
        (Number(a.employee?.id || 0) - Number(b.employee?.id || 0)) * direction
      );
    }

    const actionKey =
      sortBy === 'clock_in'
        ? 'clock_in'
        : sortBy === 'start_break'
        ? 'break_start'
        : sortBy === 'end_break'
        ? 'break_end'
        : sortBy === 'clock_out'
        ? 'clock_out'
        : null;

    if (!actionKey) {
      return sortCompanyAttendanceLogsByCreatedAt([a, b], sortOrder)[0] === a ? -1 : 1;
    }

    const aTime = getLatestPunchedAtForAction(a.punches || [], actionKey);
    const bTime = getLatestPunchedAtForAction(b.punches || [], actionKey);
    if (aTime !== bTime) {
      if (aTime === 0 && bTime === 0) return 0;
      if (aTime === 0) return 1;
      if (bTime === 0) return -1;
      return mul(aTime - bTime) * direction;
    }
    return (
      (Number(a.employee?.id || 0) - Number(b.employee?.id || 0)) * direction
    );
  });
}

function parseCompanyTodayLogsSort(query = {}) {
  const sortOrder = parsePunchListSortOrder(query);
  const sortBy = String(
    query.sort_by || query.sortBy || 'employee_name',
  )
    .trim()
    .toLowerCase();
  if (!COMPANY_TODAY_LOGS_SORT_FIELDS.has(sortBy)) {
    return {
      error: `sort_by must be one of: ${Array.from(COMPANY_TODAY_LOGS_SORT_FIELDS).join(', ')}.`,
    };
  }
  return { sortBy, sortOrder };
}

function sortCompanyCalendarsByCreatedAt(calendars = [], sortOrder = 'desc') {
  const direction = sortOrder === 'asc' ? 'asc' : 'desc';
  return [...calendars].sort((a, b) => {
    const aTime = getLatestCreatedAtFromCalendarRecords(a.records || []);
    const bTime = getLatestCreatedAtFromCalendarRecords(b.records || []);
    if (aTime !== bTime) {
      return direction === 'asc' ? aTime - bTime : bTime - aTime;
    }
    const aName = String(a.employee?.name || '');
    const bName = String(b.employee?.name || '');
    return aName.localeCompare(bName);
  });
}

function parsePunchListSortOrder(query = {}) {
  const raw = String(query.sort ?? query.order ?? query.direction ?? 'desc')
    .trim()
    .toLowerCase();
  if (raw === 'asc' || raw === 'ascending') return 'asc';
  if (raw === 'desc' || raw === 'descending') return 'desc';
  return 'desc';
}

function parsePunchDetailsPagination(query = {}) {
  const noPaginationRaw = query.no_pagination;
  if (noPaginationRaw !== undefined && noPaginationRaw !== null && noPaginationRaw !== '') {
    if (noPaginationRaw === true || noPaginationRaw === 'true' || noPaginationRaw === 1 || noPaginationRaw === '1') {
      return { noPagination: true };
    }
    if (!(noPaginationRaw === false || noPaginationRaw === 'false' || noPaginationRaw === 0 || noPaginationRaw === '0')) {
      return { error: 'no_pagination must be true or false.' };
    }
  }

  const { page, limit, offset } = parsePagination(query, {
    defaultPage: 1,
    defaultLimit: 10,
    maxLimit: 100,
  });

  return { noPagination: false, page, limit, offset };
}

function paginatePunchList(punches = [], listPagination) {
  const total = punches.length;

  if (listPagination.noPagination) {
    return {
      punches,
      pagination: buildPaginationMeta({
        page: 1,
        limit: total > 0 ? total : 1,
        total,
      }),
      no_pagination: true,
    };
  }

  const { page, limit, offset } = listPagination;
  return {
    punches: punches.slice(offset, offset + limit),
    pagination: buildPaginationMeta({ page, limit, total }),
    no_pagination: false,
  };
}

function sortPunchesForDisplay(punches = [], sortOrder = 'desc') {
  const direction = sortOrder === 'asc' ? 'asc' : 'desc';
  return [...punches].sort((a, b) => {
    const aTime = punchCreatedAtMs(a);
    const bTime = punchCreatedAtMs(b);
    if (aTime !== bTime) {
      return direction === 'asc' ? aTime - bTime : bTime - aTime;
    }
    return direction === 'asc'
      ? Number(a.id || 0) - Number(b.id || 0)
      : Number(b.id || 0) - Number(a.id || 0);
  });
}

function getPunchesBeforeAttempt(punches = [], punchedAt) {
  const attemptTime = new Date(punchedAt).getTime();
  return sortPunchTimeline(punches).filter((punch) => {
    const punchTime = new Date(punch.punched_at).getTime();
    return Number.isFinite(punchTime) && punchTime <= attemptTime;
  });
}

function replayPunchSession(punches) {
  let activeClockIn = null;
  let activeBreak = null;
  let completedSessionCount = 0;
  let completedBreakCount = 0;

  for (const punch of sortPunchTimeline(punches)) {
    const action = normalizePunchAction(punch.action_type);
    if (action === 'clock_in') {
      activeClockIn = punch;
      activeBreak = null;
    } else if (action === 'break_start' && activeClockIn) {
      activeBreak = punch;
    } else if (action === 'break_end' && activeBreak) {
      activeBreak = null;
      completedBreakCount += 1;
    } else if (action === 'clock_out' && activeClockIn && !activeBreak) {
      activeClockIn = null;
      completedSessionCount += 1;
    }
  }

  return { activeClockIn, activeBreak, completedSessionCount, completedBreakCount };
}

function buildPunchState(punches) {
  const normalizedPunches = sortPunchTimeline(normalizePunchRows(punches));
  const { activeClockIn, activeBreak, completedSessionCount, completedBreakCount } =
    replayPunchSession(normalizedPunches);

  let nextAllowedAction = 'clock_in';
  if (activeBreak) nextAllowedAction = 'break_end';
  else if (activeClockIn) nextAllowedAction = 'break_start_or_clock_out';

  const lastPunch =
    normalizedPunches.length > 0 ? normalizedPunches[normalizedPunches.length - 1] : null;
  const lastAction = lastPunch ? normalizePunchAction(lastPunch.action_type) : null;

  return {
    has_active_clock_in: Boolean(activeClockIn),
    has_active_break: Boolean(activeBreak),
    can_clock_in: !activeClockIn && !activeBreak,
    can_break_start: Boolean(activeClockIn) && !activeBreak,
    can_break_end: Boolean(activeBreak),
    can_clock_out: Boolean(activeClockIn) && !activeBreak,
    next_allowed_action: nextAllowedAction,
    last_action: lastAction,
    completed_session_count: completedSessionCount,
    completed_break_count: completedBreakCount,
    active_session_count: activeClockIn ? 1 : 0,
    supports_multiple_sessions: true,
    last_punch: formatPunchRow(lastPunch),
  };
}

function findActiveSessionDate(punches) {
  const { activeClockIn } = replayPunchSession(normalizePunchRows(punches));
  if (!activeClockIn) return null;
  return toDateKey(activeClockIn.attendance_date);
}

async function findOpenSessionDateForEmployee(client, employeeId) {
  const punches = await getPunchesForEmployee(client, employeeId);
  return findActiveSessionDate(punches);
}

function buildEndOfDayTimestamp(attendanceDate) {
  return new Date(`${attendanceDate}T23:59:59.999Z`);
}

function resolveAutoCloseTimestamps(openSessionDate, activeClockIn, activeBreak) {
  const endOfDay = buildEndOfDayTimestamp(openSessionDate);
  const endOfDayMs = endOfDay.getTime();
  const timestamps = [];

  const nextTimestampAfter = (afterMs, preferredMs = endOfDayMs) =>
    new Date(Math.min(Math.max(preferredMs, afterMs + 1000), endOfDayMs));

  let lastMs = new Date(activeClockIn.punched_at).getTime();

  if (activeBreak) {
    const breakStartMs = new Date(activeBreak.punched_at).getTime();
    lastMs = Math.max(lastMs, breakStartMs);
    timestamps.push({
      action_type: 'break_end',
      punched_at: nextTimestampAfter(lastMs, endOfDayMs - 2000),
    });
    lastMs = timestamps[timestamps.length - 1].punched_at.getTime();
  }

  timestamps.push({
    action_type: 'clock_out',
    punched_at: nextTimestampAfter(lastMs),
  });

  return timestamps;
}

async function autoCloseStaleOpenSession(
  client,
  { employeeId, openSessionDate, allPunches, source, markedBy }
) {
  const normalizedPunches = normalizePunchRows(allPunches);
  const { activeClockIn, activeBreak } = replayPunchSession(normalizedPunches);
  if (!activeClockIn) {
    return { error: 'No open session found to auto-close.' };
  }

  const resolvedOpenDate = toDateKey(activeClockIn.attendance_date) || openSessionDate;
  const autoCloseTimestamps = resolveAutoCloseTimestamps(
    resolvedOpenDate,
    activeClockIn,
    activeBreak
  );
  const insertedPunches = [];

  for (const autoCloseAction of autoCloseTimestamps) {
    const inserted = await client.query(
      `INSERT INTO attendance_punches (
         employee_id, attendance_date, action_type, punched_at, source, marked_by,
         work_location_id, latitude, longitude, remarks, attendance_status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, employee_id, attendance_date, action_type, punched_at, source, marked_by,
                 work_location_id, latitude, longitude, remarks, attendance_status, created_at`,
      [
        employeeId,
        resolvedOpenDate,
        autoCloseAction.action_type,
        dateToPgUtcTimestamp(autoCloseAction.punched_at),
        source,
        markedBy,
        activeClockIn.work_location_id ?? null,
        activeClockIn.latitude ?? null,
        activeClockIn.longitude ?? null,
        AUTO_CLOSE_SESSION_REMARK,
        'recorded',
      ]
    );
    insertedPunches.push(inserted.rows[0]);
  }

  return {
    closed_session_date: resolvedOpenDate,
    punches: insertedPunches.map((punch) => formatPunchRow(punch)),
  };
}

async function getPunchesForEmployee(client, employeeId) {
  const result = await client.query(
    `SELECT id, employee_id, attendance_date, action_type, punched_at, source, marked_by,
            work_location_id, latitude, longitude, remarks, attendance_status, created_at
     FROM attendance_punches
     WHERE employee_id = $1
     ORDER BY punched_at ASC, id ASC`,
    [employeeId]
  );
  return normalizePunchRows(result.rows);
}

function validatePunchTransition(actionType, punches = []) {
  const normalizedAction = normalizePunchAction(actionType);
  const state = buildPunchState(punches);
  const { activeClockIn, activeBreak } = replayPunchSession(normalizePunchRows(punches));

  if (normalizedAction === 'clock_in') {
    if (state.can_clock_in) return null;
    if (activeBreak) {
      return 'You are on a break. End the break, then clock out, before clocking in again.';
    }
    if (activeClockIn) {
      return 'You are already clocked in. Clock out before starting a new session.';
    }
    return 'You cannot clock in right now.';
  }
  if (normalizedAction === 'break_start' && !state.can_break_start) {
    if (activeBreak) {
      return 'End the active break before starting another break.';
    }
    if (!activeClockIn) {
      return 'Clock in before starting a break.';
    }
    return 'You cannot start a break right now.';
  }
  if (normalizedAction === 'break_end' && !state.can_break_end) {
    return 'Start a break before ending a break.';
  }
  if (normalizedAction === 'clock_out' && !state.can_clock_out) {
    if (activeBreak) {
      return 'End the active break before clocking out.';
    }
    if (!activeClockIn) {
      return 'Clock in before clocking out.';
    }
    return 'You cannot clock out right now.';
  }
  return null;
}

function validatePunchChronology(actionType, punchedAt, punches = []) {
  const normalizedAction = normalizePunchAction(actionType);
  const { activeClockIn, activeBreak } = replayPunchSession(normalizePunchRows(punches));
  const punchTime = new Date(punchedAt).getTime();
  const attemptedTime = punchedAt instanceof Date ? punchedAt.toISOString() : new Date(punchedAt).toISOString();

  if (normalizedAction === 'break_start' && activeClockIn) {
    const clockInTime = new Date(activeClockIn.punched_at).getTime();
    if (Number.isFinite(clockInTime) && punchTime <= clockInTime) {
      return {
        message: 'break_start time must be later than clock_in time.',
        clock_in_time: new Date(activeClockIn.punched_at).toISOString(),
        attempted_punch_time: attemptedTime,
      };
    }
  }

  if (normalizedAction === 'break_end' && activeBreak) {
    const breakStartTime = new Date(activeBreak.punched_at).getTime();
    if (Number.isFinite(breakStartTime) && punchTime <= breakStartTime) {
      return {
        message: 'break_end time must be later than break_start time.',
        break_start_time: new Date(activeBreak.punched_at).toISOString(),
        attempted_punch_time: attemptedTime,
      };
    }
  }

  if (normalizedAction === 'clock_out' && activeClockIn) {
    const clockInTime = new Date(activeClockIn.punched_at).getTime();
    if (Number.isFinite(clockInTime) && punchTime <= clockInTime) {
      return {
        message: 'clock_out time must be later than clock_in time.',
        clock_in_time: new Date(activeClockIn.punched_at).toISOString(),
        attempted_punch_time: attemptedTime,
      };
    }
    if (activeBreak) {
      const breakStartTime = new Date(activeBreak.punched_at).getTime();
      if (Number.isFinite(breakStartTime) && punchTime <= breakStartTime) {
        return {
          message: 'clock_out time must be later than break_start time.',
          break_start_time: new Date(activeBreak.punched_at).toISOString(),
          attempted_punch_time: attemptedTime,
        };
      }
    }
  }

  return null;
}

function buildPunchMetrics(punches) {
  const sessions = [];
  const breaks = [];
  let activeSession = null;
  let activeBreak = null;
  let completedWorkMinutes = 0;
  let completedBreakMinutes = 0;

  for (const punch of sortPunchTimeline(normalizePunchRows(punches))) {
    const punchedAt = new Date(punch.punched_at);
    const action = normalizePunchAction(punch.action_type);
    if (action === 'clock_in') {
      activeSession = {
        clock_in_punch_id: Number(punch.id),
        clock_in_time: punch.punched_at,
        clock_out_punch_id: null,
        clock_out_time: null,
        work_minutes: null,
        work_hours: null,
      };
      activeBreak = null;
    } else if (action === 'break_start' && activeSession && !activeBreak) {
      activeBreak = {
        break_start_punch_id: Number(punch.id),
        break_start_time: punch.punched_at,
        break_end_punch_id: null,
        break_end_time: null,
        duration_minutes: null,
      };
    } else if (action === 'break_end' && activeBreak) {
      const minutes = Math.max(
        Math.floor((punchedAt.getTime() - new Date(activeBreak.break_start_time).getTime()) / 60000),
        0
      );
      activeBreak.break_end_punch_id = Number(punch.id);
      activeBreak.break_end_time = punch.punched_at;
      activeBreak.duration_minutes = minutes;
      completedBreakMinutes += minutes;
      breaks.push(activeBreak);
      activeBreak = null;
    } else if (action === 'clock_out' && activeSession && !activeBreak) {
      const grossMinutes = Math.max(
        Math.floor((punchedAt.getTime() - new Date(activeSession.clock_in_time).getTime()) / 60000),
        0
      );
      const sessionBreakMinutes = breaks
        .filter(
          (b) =>
            new Date(b.break_start_time).getTime() >= new Date(activeSession.clock_in_time).getTime() &&
            new Date(b.break_end_time).getTime() <= punchedAt.getTime()
        )
        .reduce((sum, b) => sum + Number(b.duration_minutes || 0), 0);
      const workMinutes = Math.max(grossMinutes - sessionBreakMinutes, 0);
      activeSession.clock_out_punch_id = Number(punch.id);
      activeSession.clock_out_time = punch.punched_at;
      activeSession.work_minutes = workMinutes;
      activeSession.work_hours = Number((workMinutes / 60).toFixed(2));
      completedWorkMinutes += workMinutes;
      sessions.push(activeSession);
      activeSession = null;
    }
  }

  if (activeBreak) breaks.push(activeBreak);
  if (activeSession) sessions.push(activeSession);

  let inProgressWorkMinutes = 0;
  if (activeSession?.clock_in_time && !activeSession.clock_out_time) {
    const now = new Date();
    const grossMinutes = Math.max(
      Math.floor((now.getTime() - new Date(activeSession.clock_in_time).getTime()) / 60000),
      0
    );
    const openSessionBreakMinutes = breaks
      .filter(
        (b) =>
          b.break_end_time &&
          new Date(b.break_start_time).getTime() >= new Date(activeSession.clock_in_time).getTime()
      )
      .reduce((sum, b) => sum + Number(b.duration_minutes || 0), 0);
    inProgressWorkMinutes = Math.max(grossMinutes - openSessionBreakMinutes, 0);
  }

  const hasCompletedWork = sessions.some((session) => session.clock_out_time);
  const hasCompletedBreak = breaks.some((item) => item.break_end_time);

  return {
    sessions,
    break_sessions: breaks,
    completed_work_minutes: completedWorkMinutes,
    in_progress_work_minutes: inProgressWorkMinutes,
    // Working hours are only reported after clock_out (completed sessions).
    actual_work_minutes: hasCompletedWork ? completedWorkMinutes : null,
    actual_work_hours: hasCompletedWork ? Number((completedWorkMinutes / 60).toFixed(2)) : null,
    actual_break_minutes: hasCompletedBreak ? completedBreakMinutes : null,
    actual_break_hours: hasCompletedBreak ? Number((completedBreakMinutes / 60).toFixed(2)) : null,
  };
}

function buildScheduledDetails(row) {
  const attendanceSchedule =
    row?.attendance_schedule && typeof row.attendance_schedule === 'object'
      ? row.attendance_schedule
      : {};
  const shiftStart = row?.shift_start || attendanceSchedule.shift_start || row?.location_shift_start;
  const shiftEnd = row?.shift_end || attendanceSchedule.shift_end || row?.location_shift_end;
  const shiftBreakMinutes =
    row?.break_start_time && row?.break_end_time
      ? durationMinutesBetweenTimes(row.break_start_time, row.break_end_time)
      : null;
  const scheduledBreakMinutes = Number(
    shiftBreakMinutes ??
      row?.location_break_minutes ??
      attendanceSchedule.break_minutes ??
      0
  );
  const grossWorkMinutes = durationMinutesBetweenTimes(shiftStart, shiftEnd);
  const excludeBreak = row?.exclude_break_from_working_hours === true;
  const scheduledWorkMinutes = Math.max(grossWorkMinutes - (excludeBreak ? scheduledBreakMinutes : 0), 0);

  return {
    assigned_shift: row?.shift_id
      ? {
          id: Number(row.shift_id),
          name: row.shift_name,
          start_time: shiftStart || null,
          end_time: shiftEnd || null,
          break_start_time: row.break_start_time || null,
          break_end_time: row.break_end_time || null,
          working_days: normalizeWorkingDays(row.working_days),
          working_hours_threshold_minutes: resolveShiftGraceMinutes(row),
          grace_minutes: resolveShiftGraceMinutes(row),
          exclude_break_from_working_hours: Boolean(row.exclude_break_from_working_hours),
        }
      : null,
    scheduled_work_minutes: shiftStart && shiftEnd ? scheduledWorkMinutes : null,
    scheduled_work_hours: shiftStart && shiftEnd ? Number((scheduledWorkMinutes / 60).toFixed(2)) : null,
    scheduled_break_minutes: scheduledBreakMinutes,
    scheduled_break_hours: Number((scheduledBreakMinutes / 60).toFixed(2)),
    shift_start: shiftStart || null,
    shift_end: shiftEnd || null,
    work_location: row?.work_location_id
      ? {
          id: Number(row.work_location_id),
          name: row.work_location_name,
          latitude: row.work_location_latitude != null ? Number(row.work_location_latitude) : null,
          longitude: row.work_location_longitude != null ? Number(row.work_location_longitude) : null,
          radius_meters: row.work_location_radius_meters != null ? Number(row.work_location_radius_meters) : null,
          geofencing_enabled: Boolean(row.work_location_geofencing_enabled),
        }
      : null,
  };
}

async function getEmployeeAttendanceProfile(client, employeeId) {
  const result = await client.query(
    `SELECT
       e.id,
       e.first_name,
       e.last_name,
       e.employee_code,
       e.work_email,
       e.attendance_schedule,
       e.dob,
       e.company_id,
       c.timezone AS company_timezone,
       ejd.joining_date,
       ejd.hire_date,
       ejd.work_location_id,
       wl.name AS work_location_name,
       wl.latitude AS work_location_latitude,
       wl.longitude AS work_location_longitude,
       wl.radius_meters AS work_location_radius_meters,
       wl.geofencing_enabled AS work_location_geofencing_enabled,
       wl.shift_start AS location_shift_start,
       wl.shift_end AS location_shift_end,
       wl.break_minutes AS location_break_minutes,
       wl.grace_minutes AS location_grace_minutes,
       ejd.shift_id,
       s.name AS shift_name,
       s.start_time AS shift_start,
       s.end_time AS shift_end,
       s.break_start_time,
       s.break_end_time,
       s.working_days,
       s.working_hours_threshold_minutes,
       s.exclude_break_from_working_hours
     FROM employees e
     LEFT JOIN companies c ON c.id = e.company_id
     LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
     LEFT JOIN attendance_location_settings wl ON wl.id = ejd.work_location_id
     LEFT JOIN shifts s ON s.id = ejd.shift_id
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

async function buildPunchDetails(client, employeeId, attendanceDate) {
  const employee = await getEmployeeAttendanceProfile(client, employeeId);
  if (!employee) return null;
  const punches = await getPunchesForDate(client, employeeId, attendanceDate);
  return buildPunchDetailsFromProfile(employee, attendanceDate, punches);
}

function buildPunchDetailsFromProfile(employee, attendanceDate, punches = [], options = {}) {
  const metrics = buildPunchMetrics(punches);
  const punchAssignment = buildPunchAssignment(employee);
  const state = buildPunchState(punches);
  if (!punchAssignment.can_punch) {
    state.can_clock_in = false;
    state.can_break_start = false;
    state.can_break_end = false;
    state.can_clock_out = false;
    state.next_allowed_action = null;
    state.punch_blocked_reason = punchAssignment.message;
  }
  const scheduled = buildScheduledDetails(employee);
  const attendanceClockIn = findLatestClockIn(punches);
  const shiftValidation = alignShiftValidationWithStoredClockIn(
    buildShiftValidation(employee, attendanceDate, attendanceClockIn?.punched_at),
    attendanceClockIn
  );
  const oldestPunch = sortPunchesForDisplay(punches, 'asc')[0];
  const latestPunch = findLatestPunchByCreatedAt(punches);

  return applyAttendancePresentationToDetails(
    {
      employee: {
        id: Number(employee.id),
        name: `${employee.first_name} ${employee.last_name}`.trim(),
        employee_code: employee.employee_code,
        work_email: employee.work_email,
      },
      attendance_date: attendanceDate,
      punch_id: oldestPunch?.id ? Number(oldestPunch.id) : null,
      latest_punch_id: latestPunch?.id ? Number(latestPunch.id) : null,
      ...scheduled,
      punch_assignment: punchAssignment,
      schedule_validation: shiftValidation,
      actual_work_minutes: metrics.actual_work_minutes,
      actual_work_hours: metrics.actual_work_hours,
      actual_break_minutes: metrics.actual_break_minutes,
      actual_break_hours: metrics.actual_break_hours,
      sessions: metrics.sessions,
      break_sessions: metrics.break_sessions,
      state,
    },
    employee,
    attendanceDate,
    punches,
    options
  );
}

const COMPANY_EMPLOYEE_ATTENDANCE_SELECT = `
  e.id,
  e.first_name,
  e.last_name,
  e.employee_code,
  e.work_email,
  e.attendance_schedule,
  e.dob,
  e.company_id,
  c.timezone AS company_timezone,
  ejd.joining_date,
  ejd.hire_date,
  ejd.work_location_id,
  ejd.department_id,
  ejd.designation_id,
  d.name AS department_name,
  des.name AS designation_name,
  wl.name AS work_location_name,
  wl.latitude AS work_location_latitude,
  wl.longitude AS work_location_longitude,
  wl.radius_meters AS work_location_radius_meters,
  wl.geofencing_enabled AS work_location_geofencing_enabled,
  wl.shift_start AS location_shift_start,
  wl.shift_end AS location_shift_end,
  wl.break_minutes AS location_break_minutes,
  wl.grace_minutes AS location_grace_minutes,
  ejd.shift_id,
  s.name AS shift_name,
  s.start_time AS shift_start,
  s.end_time AS shift_end,
  s.break_start_time,
  s.break_end_time,
  s.working_days,
  s.working_hours_threshold_minutes,
  s.exclude_break_from_working_hours
`;

async function getAuthenticatedCompanyAdmin(req) {
  const auth = getRequestAuth(req);
  if (!auth) return { error: [401, 'Authorization token is required.'] };
  const result = await pool.query(
    `SELECT id, email, role, is_active, company_id
     FROM users
     WHERE id = $1 AND email = $2`,
    [auth.userId, auth.email]
  );
  if (result.rowCount === 0) return { error: [401, 'Authenticated user not found.'] };
  const admin = result.rows[0];
  if (admin.role !== USER_ROLES.COMPANY_ADMIN) {
    return { error: [403, 'Only a Company Admin can perform this action.'] };
  }
  if (!admin.is_active) return { error: [403, 'Your account is inactive.'] };
  if (!admin.company_id) {
    return { error: [403, 'Your account must be linked to a company.'] };
  }
  return { admin };
}

function mapCompanyAdminTodayLogEntry(employeeRow, attendanceDetails) {
  const { employee: baseEmployee, ...attendanceData } = attendanceDetails;
  return {
    employee: mapCompanyEmployeeSummary(employeeRow),
    ...attendanceData,
  };
}

function mapCompanyEmployeeSummary(employeeRow) {
  return {
    id: Number(employeeRow.id),
    name: `${employeeRow.first_name} ${employeeRow.last_name}`.trim(),
    employee_code: employeeRow.employee_code,
    work_email: employeeRow.work_email,
    dob: toDateKey(employeeRow.dob),
    joining_date: toDateKey(employeeRow.joining_date) || toDateKey(employeeRow.hire_date),
    department: employeeRow.department_id
      ? { id: Number(employeeRow.department_id), name: employeeRow.department_name }
      : null,
    designation: employeeRow.designation_id
      ? { id: Number(employeeRow.designation_id), name: employeeRow.designation_name }
      : null,
  };
}

const COMPANY_CALENDAR_STATUS_FILTERS = new Set([
  'present',
  'late',
  'absent',
  'off_day',
  'holiday',
  'on_leave',
]);

function parseCompanyCalendarFilters(query = {}) {
  const search = String(query.search || query.name || '').trim();
  const statusFilter = String(query.status || '').trim().toLowerCase();
  if (statusFilter && !COMPANY_CALENDAR_STATUS_FILTERS.has(statusFilter)) {
    return {
      error: 'status must be one of: present, late, absent, off_day, holiday, on_leave.',
    };
  }

  return {
    search,
    statusFilter,
    employeeId: parsePositiveInt(query.employee_id ?? query.employeeId),
    departmentId: parsePositiveInt(query.department_id ?? query.departmentId),
    designationId: parsePositiveInt(query.designation_id ?? query.designationId),
    shiftId: parsePositiveInt(query.shift_id ?? query.shiftId),
    workLocationId: parsePositiveInt(query.work_location_id ?? query.workLocationId),
  };
}

function appendCompanyEmployeeAttendanceFilters(whereParts, values, filters = {}) {
  const {
    search,
    employeeId,
    departmentId,
    designationId,
    shiftId,
    workLocationId,
  } = filters;

  if (search) {
    values.push(`%${search}%`);
    const searchIndex = values.length;
    whereParts.push(`(
      e.first_name ILIKE $${searchIndex}
      OR e.last_name ILIKE $${searchIndex}
      OR CONCAT(e.first_name, ' ', e.last_name) ILIKE $${searchIndex}
      OR e.employee_code ILIKE $${searchIndex}
      OR COALESCE(e.employee_id, '') ILIKE $${searchIndex}
    )`);
  }
  if (employeeId) {
    values.push(employeeId);
    whereParts.push(`e.id = $${values.length}`);
  }
  if (departmentId) {
    values.push(departmentId);
    whereParts.push(`ejd.department_id = $${values.length}`);
  }
  if (designationId) {
    values.push(designationId);
    whereParts.push(`ejd.designation_id = $${values.length}`);
  }
  if (shiftId) {
    values.push(shiftId);
    whereParts.push(`ejd.shift_id = $${values.length}`);
  }
  if (workLocationId) {
    values.push(workLocationId);
    whereParts.push(`ejd.work_location_id = $${values.length}`);
  }
}

function buildCompanyTodayLogsSummary(logs) {
  const summary = {
    total_employees: logs.length,
    present: 0,
    late: 0,
    absent: 0,
    off_day: 0,
    holiday: 0,
    with_activity: 0,
  };

  for (const log of logs) {
    const status = String(log.status || '').toLowerCase();
    if (status === 'present') summary.present += 1;
    else if (status === 'late') summary.late += 1;
    else if (status === 'absent') summary.absent += 1;
    else if (status === 'off_day') summary.off_day += 1;
    else if (status === 'holiday') summary.holiday += 1;
    if (Array.isArray(log.punches) && log.punches.length > 0) {
      summary.with_activity += 1;
    }
  }

  return summary;
}

const COMPANY_HISTORY_MAX_RANGE_DAYS = 93;
const COMPANY_HISTORY_SORT_FIELDS = new Set(['attendance_date', 'created_at', 'employee_name', 'department']);

function parseCompanyHistoryDateRange(query = {}) {
  const today = getTodayDateString();
  const month = parseMonth(query.month);

  if (month) {
    const [year, monthNumber] = month.split('-').map(Number);
    return {
      dateFrom: `${month}-01`,
      dateTo: `${month}-${String(daysInMonth(year, monthNumber)).padStart(2, '0')}`,
    };
  }

  let dateFrom = String(query.date_from || query.from || '').trim();
  let dateTo = String(query.date_to || query.to || '').trim();

  if (!dateFrom && !dateTo) {
    const currentMonth = today.slice(0, 7);
    const [year, monthNumber] = currentMonth.split('-').map(Number);
    dateFrom = `${currentMonth}-01`;
    dateTo = `${currentMonth}-${String(daysInMonth(year, monthNumber)).padStart(2, '0')}`;
  } else {
    dateFrom = dateFrom || dateTo;
    dateTo = dateTo || dateFrom;
  }

  const dateFromParsed = parseRequiredDateInput(dateFrom, 'date_from');
  if (dateFromParsed.error) {
    return { error: dateFromParsed.error };
  }
  const dateToParsed = parseRequiredDateInput(dateTo, 'date_to');
  if (dateToParsed.error) {
    return { error: dateToParsed.error };
  }
  dateFrom = dateFromParsed.value;
  dateTo = dateToParsed.value;
  if (dateFrom > dateTo) {
    return { error: 'date_from cannot be greater than date_to.' };
  }

  const rangeDays =
    Math.floor(
      (new Date(`${dateTo}T00:00:00Z`).getTime() - new Date(`${dateFrom}T00:00:00Z`).getTime()) /
        86400000
    ) + 1;
  if (rangeDays > COMPANY_HISTORY_MAX_RANGE_DAYS) {
    return {
      error: `Date range cannot exceed ${COMPANY_HISTORY_MAX_RANGE_DAYS} days. Use month or narrower filters.`,
    };
  }

  return { dateFrom, dateTo, rangeDays };
}

function parseCompanyHistorySort(query = {}) {
  const sortOrder = parsePunchListSortOrder(query);
  const sortBy = String(query.sort_by || 'attendance_date').trim().toLowerCase();
  if (!COMPANY_HISTORY_SORT_FIELDS.has(sortBy)) {
    return { error: 'sort_by must be one of: attendance_date, created_at, employee_name.' };
  }
  return { sortBy, sortOrder };
}

function parseBooleanQueryFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return null;
}

function listDateKeysBetween(dateFrom, dateTo) {
  const dates = [];
  const cursor = new Date(`${dateFrom}T00:00:00Z`);
  const endMs = new Date(`${dateTo}T00:00:00Z`).getTime();
  while (cursor.getTime() <= endMs) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function buildCompanyHistoryDayRecord(employeeRow, attendanceDate, punches, options = {}) {
  const details = buildPunchDetailsFromProfile(employeeRow, attendanceDate, punches, options);
  return mapCompanyAdminTodayLogEntry(employeeRow, details);
}

function sortCompanyHistoryRecords(records = [], sortBy = 'attendance_date', sortOrder = 'desc') {
  const direction = sortOrder === 'asc' ? 1 : -1;
  return [...records].sort((a, b) => {
    if (sortBy === 'employee_name') {
      const nameCmp = String(a.employee?.name || '').localeCompare(String(b.employee?.name || ''));
      if (nameCmp !== 0) return nameCmp * direction;
      const dateCmp = String(a.attendance_date).localeCompare(String(b.attendance_date));
      if (dateCmp !== 0) return dateCmp * -direction;
      return (
        (getLatestCreatedAtFromPunches(b.punches || []) -
          getLatestCreatedAtFromPunches(a.punches || [])) * direction
      );
    }

    if (sortBy === 'created_at') {
      const aTime = getLatestCreatedAtFromPunches(a.punches || []);
      const bTime = getLatestCreatedAtFromPunches(b.punches || []);
      if (aTime !== bTime) return (aTime - bTime) * direction;
      const dateCmp = String(a.attendance_date).localeCompare(String(b.attendance_date));
      if (dateCmp !== 0) return dateCmp * direction;
      return (Number(a.employee?.id || 0) - Number(b.employee?.id || 0)) * direction;
    }

    if (sortBy === 'department') {
      const aDept = String(a.employee?.department?.name || '').toLowerCase();
      const bDept = String(b.employee?.department?.name || '').toLowerCase();
      const deptCmp = aDept.localeCompare(bDept);
      if (deptCmp !== 0) return deptCmp * direction;
      const dateCmp = String(a.attendance_date).localeCompare(String(b.attendance_date));
      if (dateCmp !== 0) return dateCmp * direction;
      return (Number(a.employee?.id || 0) - Number(b.employee?.id || 0)) * direction;
    }

    const dateCmp = String(a.attendance_date).localeCompare(String(b.attendance_date));
    if (dateCmp !== 0) return dateCmp * direction;
    const aTime = getLatestCreatedAtFromPunches(a.punches || []);
    const bTime = getLatestCreatedAtFromPunches(b.punches || []);
    if (aTime !== bTime) return (aTime - bTime) * direction;
    return (Number(a.employee?.id || 0) - Number(b.employee?.id || 0)) * direction;
  });
}

function buildCompanyHistorySummary(records = []) {
  const summary = {
    total_records: records.length,
    total_employees: new Set(records.map((record) => record.employee?.id).filter(Boolean)).size,
    present: 0,
    late: 0,
    absent: 0,
    off_day: 0,
    holiday: 0,
    with_activity: 0,
  };

  for (const record of records) {
    const status = String(record.status || '').toLowerCase();
    if (status === 'present') summary.present += 1;
    else if (status === 'late') summary.late += 1;
    else if (status === 'absent') summary.absent += 1;
    else if (status === 'off_day') summary.off_day += 1;
    else if (status === 'holiday') summary.holiday += 1;
    if (Array.isArray(record.punches) && record.punches.length > 0) {
      summary.with_activity += 1;
    }
  }

  return summary;
}

async function getCompanyAdminTodayLogs(req, res) {
  const auth = await getAuthenticatedCompanyAdmin(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

  const attendanceDateParsed = parseRequiredDateInput(
    req.query?.attendance_date || req.query?.date || getTodayDateString(),
    'attendance_date'
  );
  if (attendanceDateParsed.error) {
    return sendError(res, 400, attendanceDateParsed.error);
  }
  const attendanceDate = attendanceDateParsed.value;

  const search = String(req.query?.search || req.query?.name || '').trim();
  const filters = parseCompanyCalendarFilters(req.query);
  if (filters.error) return sendError(res, 400, filters.error);
  const statusFilter = filters.statusFilter;
  const sort = parseCompanyTodayLogsSort(req.query);
  if (sort.error) return sendError(res, 400, sort.error);
  const { sortBy, sortOrder } = sort;

  const { page, limit, offset } = parsePagination(req.query, {
    defaultPage: 1,
    defaultLimit: 100,
    maxLimit: 500,
  });

  const client = await pool.connect();
  try {
    const companyId = Number(auth.admin.company_id);
    const whereParts = ['e.company_id = $1'];
    const values = [companyId];
    appendCompanyEmployeeAttendanceFilters(whereParts, values, { ...filters, search });

    const whereClause = whereParts.join(' AND ');
    const employeesResult = await client.query(
      `SELECT ${COMPANY_EMPLOYEE_ATTENDANCE_SELECT}
       FROM employees e
       LEFT JOIN companies c ON c.id = e.company_id
       LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
       LEFT JOIN departments d ON d.id = ejd.department_id
       LEFT JOIN designations des ON des.id = ejd.designation_id
       LEFT JOIN attendance_location_settings wl ON wl.id = ejd.work_location_id
       LEFT JOIN shifts s ON s.id = ejd.shift_id
       WHERE ${whereClause}
       ORDER BY e.first_name ASC, e.last_name ASC, e.id ASC`,
      values
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

    const includeWithoutPunches = parseBooleanQueryFlag(
      req.query?.include_without_punches ?? req.query?.include_empty_days,
      true
    );
    if (includeWithoutPunches === null) {
      return sendError(res, 400, 'include_without_punches must be true or false.');
    }

    let logs = employeeRows.map((employeeRow) => {
      const punches = punchesByEmployee.get(Number(employeeRow.id)) || [];
      const details = buildPunchDetailsFromProfile(employeeRow, attendanceDate, punches, { sortOrder });
      return mapCompanyAdminTodayLogEntry(employeeRow, details);
    });

    // When false, only return employees who punched on attendance_date so date
    // changes visibly filter the table instead of repeating the full roster.
    if (!includeWithoutPunches) {
      logs = logs.filter((log) => Array.isArray(log.punches) && log.punches.length > 0);
    }

    if (statusFilter) {
      logs = logs.filter((log) => String(log.status || '').toLowerCase() === statusFilter);
    }

    logs = sortCompanyTodayLogs(logs, sortBy, sortOrder);

    const summary = buildCompanyTodayLogsSummary(logs);
    const total = logs.length;
    const paginatedLogs = logs.slice(offset, offset + limit);

    return sendSuccess(res, 200, 'Company attendance logs fetched successfully.', {
      company_id: companyId,
      attendance_date: attendanceDate,
      sort_by: sortBy,
      sort: sortOrder,
      include_without_punches: includeWithoutPunches,
      filters: {
        employee_id: filters.employeeId,
        department_id: filters.departmentId,
        designation_id: filters.designationId,
        shift_id: filters.shiftId,
        work_location_id: filters.workLocationId,
        status: filters.statusFilter || null,
        search: filters.search || null,
      },
      logs: paginatedLogs,
      summary,
      pagination: buildPaginationMeta({ page, limit, total }),
    });
  } catch (error) {
    console.error('Get company admin today logs error:', error);
    return sendError(res, 500, 'Something went wrong while fetching company attendance logs.');
  } finally {
    client.release();
  }
}

function buildPunchLocationMeta(punch, workLocationRow) {
  const latitude = punch.latitude != null ? Number(punch.latitude) : null;
  const longitude = punch.longitude != null ? Number(punch.longitude) : null;
  const allottedLatitude =
    workLocationRow?.latitude != null ? Number(workLocationRow.latitude) : null;
  const allottedLongitude =
    workLocationRow?.longitude != null ? Number(workLocationRow.longitude) : null;
  const radiusMeters =
    workLocationRow?.radius_meters != null
      ? Number(workLocationRow.radius_meters)
      : DEFAULT_GEOFENCE_RADIUS_METERS;

  let distanceMeters = null;
  let isWithinRadius = null;
  if (
    latitude !== null &&
    longitude !== null &&
    allottedLatitude !== null &&
    allottedLongitude !== null
  ) {
    distanceMeters = Number(
      haversineDistanceMeters(latitude, longitude, allottedLatitude, allottedLongitude).toFixed(2)
    );
    isWithinRadius = distanceMeters <= radiusMeters;
  }

  return {
    latitude,
    longitude,
    distance_meters: distanceMeters,
    is_within_radius: isWithinRadius,
    work_location: workLocationRow
      ? {
          id: Number(workLocationRow.id),
          name: workLocationRow.name,
          latitude: allottedLatitude,
          longitude: allottedLongitude,
          radius_meters: radiusMeters,
          address: workLocationRow.address ?? null,
          geofencing_enabled: Boolean(workLocationRow.geofencing_enabled),
        }
      : null,
  };
}

function formatCompanyAdminPunchDetail(punch, employee, attendanceDate, extras = {}) {
  const formatted = formatPunchRowWithAttendanceStatus(punch, employee, attendanceDate);
  if (!formatted) return null;

  return {
    ...formatted,
    action_label: formatPunchActionLabel(punch.action_type),
    attendance_status: resolvePunchAttendanceStatus(punch, employee, attendanceDate),
    marked_by: extras.markedByUser
      ? {
          id: Number(extras.markedByUser.id),
          name: extras.markedByUser.full_name,
          email: extras.markedByUser.email,
          role: extras.markedByUser.role,
        }
      : formatted.marked_by != null
        ? { id: formatted.marked_by }
        : null,
    location: buildPunchLocationMeta(punch, extras.workLocationRow),
    timeline_index: extras.timelineIndex ?? null,
    timeline_total: extras.timelineTotal ?? null,
  };
}

async function getCompanyAdminPunchDetails(req, res) {
  const auth = await getAuthenticatedCompanyAdmin(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

  const punchId = parsePositiveInt(req.params.punch_id ?? req.params.id ?? req.query?.punch_id);
  if (!punchId) {
    return sendError(res, 400, 'punch_id must be a positive integer.');
  }

  const client = await pool.connect();
  try {
    const companyId = Number(auth.admin.company_id);
    const punchResult = await client.query(
      `SELECT
         ap.id,
         ap.employee_id,
         ap.attendance_date,
         ap.action_type,
         ap.punched_at,
         ap.source,
         ap.marked_by,
         ap.work_location_id,
         ap.latitude,
         ap.longitude,
         ap.remarks,
         ap.attendance_status,
         ap.created_at,
         mu.id AS marked_by_user_id,
         mu.full_name AS marked_by_full_name,
         mu.email AS marked_by_email,
         mu.role AS marked_by_role,
         wl.id AS work_location_row_id,
         wl.name AS work_location_name,
         wl.latitude AS work_location_latitude,
         wl.longitude AS work_location_longitude,
         wl.radius_meters AS work_location_radius_meters,
         wl.address AS work_location_address,
         wl.geofencing_enabled AS work_location_geofencing_enabled
       FROM attendance_punches ap
       INNER JOIN employees e ON e.id = ap.employee_id
       LEFT JOIN users mu ON mu.id = ap.marked_by
       LEFT JOIN attendance_location_settings wl ON wl.id = ap.work_location_id
       WHERE ap.id = $1 AND e.company_id = $2`,
      [punchId, companyId]
    );

    if (punchResult.rowCount === 0) {
      return sendError(res, 404, 'Punch not found for this company.');
    }

    const punchRow = normalizePunchRows(punchResult.rows)[0];
    const employeeId = Number(punchRow.employee_id);
    const attendanceDate = toDateKey(punchRow.attendance_date) || String(punchRow.attendance_date).slice(0, 10);

    const employeeResult = await client.query(
      `SELECT ${COMPANY_EMPLOYEE_ATTENDANCE_SELECT}
       FROM employees e
       LEFT JOIN companies c ON c.id = e.company_id
       LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
       LEFT JOIN departments d ON d.id = ejd.department_id
       LEFT JOIN designations des ON des.id = ejd.designation_id
       LEFT JOIN attendance_location_settings wl ON wl.id = ejd.work_location_id
       LEFT JOIN shifts s ON s.id = ejd.shift_id
       WHERE e.id = $1 AND e.company_id = $2`,
      [employeeId, companyId]
    );

    if (employeeResult.rowCount === 0) {
      return sendError(res, 404, 'Employee not found for this company.');
    }

    const employeeRow = employeeResult.rows[0];
    const dayPunches = await getPunchesForDate(client, employeeId, attendanceDate);
    const sortOrder = parsePunchListSortOrder(req.query);
    const dayDetails = mapCompanyAdminTodayLogEntry(
      employeeRow,
      buildPunchDetailsFromProfile(employeeRow, attendanceDate, dayPunches, { sortOrder })
    );

    const sortedPunchIds = (dayDetails.punches || []).map((item) => Number(item.id));
    const timelineIndex = sortedPunchIds.indexOf(punchId);
    const markedByUser = punchResult.rows[0].marked_by_user_id
      ? {
          id: punchResult.rows[0].marked_by_user_id,
          full_name: punchResult.rows[0].marked_by_full_name,
          email: punchResult.rows[0].marked_by_email,
          role: punchResult.rows[0].marked_by_role,
        }
      : null;
    const workLocationRow = punchResult.rows[0].work_location_row_id
      ? {
          id: punchResult.rows[0].work_location_row_id,
          name: punchResult.rows[0].work_location_name,
          latitude: punchResult.rows[0].work_location_latitude,
          longitude: punchResult.rows[0].work_location_longitude,
          radius_meters: punchResult.rows[0].work_location_radius_meters,
          address: punchResult.rows[0].work_location_address,
          geofencing_enabled: punchResult.rows[0].work_location_geofencing_enabled,
        }
      : null;

    const punch = formatCompanyAdminPunchDetail(punchRow, employeeRow, attendanceDate, {
      markedByUser,
      workLocationRow,
      timelineIndex: timelineIndex >= 0 ? timelineIndex + 1 : null,
      timelineTotal: sortedPunchIds.length,
    });

    return sendSuccess(res, 200, 'Punch details fetched successfully.', {
      company_id: companyId,
      punch_id: punchId,
      attendance_date: attendanceDate,
      sort: sortOrder,
      punch,
      employee: dayDetails.employee,
      day_log: {
        status: dayDetails.status,
        schedule_validation: dayDetails.schedule_validation,
        assigned_shift: dayDetails.assigned_shift,
        work_location: dayDetails.work_location,
        scheduled_work_minutes: dayDetails.scheduled_work_minutes,
        scheduled_work_hours: dayDetails.scheduled_work_hours,
        scheduled_break_minutes: dayDetails.scheduled_break_minutes,
        scheduled_break_hours: dayDetails.scheduled_break_hours,
        shift_start: dayDetails.shift_start,
        shift_end: dayDetails.shift_end,
        actual_work_minutes: dayDetails.actual_work_minutes,
        actual_work_hours: dayDetails.actual_work_hours,
        actual_break_minutes: dayDetails.actual_break_minutes,
        actual_break_hours: dayDetails.actual_break_hours,
        sessions: dayDetails.sessions,
        break_sessions: dayDetails.break_sessions,
        state: dayDetails.state,
        punches: dayDetails.punches,
      },
    });
  } catch (error) {
    console.error('Get company admin punch details error:', error);
    return sendError(res, 500, 'Something went wrong while fetching punch details.');
  } finally {
    client.release();
  }
}

async function requireAttendanceAdmin(req) {
  const auth = getRequestAuth(req);
  if (!auth) return { error: [401, 'Authorization token is required.'] };
  const result = await pool.query(
    'SELECT id, email, role, is_active FROM users WHERE id = $1 AND email = $2',
    [auth.userId, auth.email]
  );
  if (result.rowCount === 0) return { error: [401, 'Authenticated user not found.'] };
  const user = result.rows[0];
  if (!user.is_active) return { error: [403, 'Your account is inactive.'] };
  if (!ADMIN_ATTENDANCE_ROLES.has(user.role)) {
    return { error: [403, 'Only an admin can perform this action.'] };
  }
  return { admin: user };
}

async function createPunch({
  req,
  res,
  employeeId,
  source,
  markedBy,
  verifyLocation,
  verifyGeofence = verifyLocation,
}) {
  const actionType = normalizePunchAction(req.body?.action_type ?? req.body?.action);
  if (!PUNCH_ACTIONS.has(actionType)) {
    return sendError(
      res,
      400,
      'action_type must be one of: clock_in, break_start, break_end, clock_out.'
    );
  }

  const location = extractLocation(req.body || {});
  if (location.error) return sendError(res, 400, location.error);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [employeeId]);

    const employee = await getEmployeeAttendanceProfile(client, employeeId);
    if (!employee) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'Employee not found.');
    }

    const punchAssignment = buildPunchAssignment(employee);
    if (!punchAssignment.can_punch) {
      await client.query('ROLLBACK');
      return sendError(res, 400, punchAssignment.message, {
        punch_assignment: punchAssignment,
      });
    }

    const openSessionDate =
      actionType === 'clock_in' ? null : await findOpenSessionDateForEmployee(client, employeeId);
    const parsedDateTime = parsePunchDateTime(
      req.body || {},
      openSessionDate,
      employee.company_timezone
    );
    if (parsedDateTime.error) {
      await client.query('ROLLBACK');
      return sendError(res, 400, parsedDateTime.error);
    }

    let workLocationId = employee.work_location_id ? Number(employee.work_location_id) : null;
    let distanceMeters = null;
    let dayPunches = await getPunchesForDate(client, employeeId, parsedDateTime.attendanceDate);
    let allPunches = await getPunchesForEmployee(client, employeeId);
    let punches = actionType === 'clock_in' ? dayPunches : allPunches;
    let autoClosedSession = null;

    if (actionType === 'clock_in') {
      const openSessionDate = findActiveSessionDate(allPunches);
      if (openSessionDate && openSessionDate !== parsedDateTime.attendanceDate) {
        if (openSessionDate > parsedDateTime.attendanceDate) {
          const globalState = buildPunchState(allPunches);
          await client.query('ROLLBACK');
          return sendError(
            res,
            409,
            `You have an open session on ${openSessionDate}. Clock out before starting a new session.`,
            { state: globalState, open_session_date: openSessionDate }
          );
        }

        autoClosedSession = await autoCloseStaleOpenSession(client, {
          employeeId,
          openSessionDate,
          allPunches,
          source,
          markedBy,
        });
        if (autoClosedSession.error) {
          await client.query('ROLLBACK');
          return sendError(res, 500, autoClosedSession.error);
        }

        allPunches = await getPunchesForEmployee(client, employeeId);
        dayPunches = await getPunchesForDate(client, employeeId, parsedDateTime.attendanceDate);
        punches = dayPunches;
      }
    }

    const isAdditionalSessionToday = dayPunches.some(
      (p) => normalizePunchAction(p.action_type) === 'clock_out'
    );

    if (verifyLocation && actionType === 'clock_in') {
      const shiftValidation = buildShiftValidation(
        employee,
        parsedDateTime.attendanceDate,
        parsedDateTime.punchedAt
      );

      if (!isAdditionalSessionToday) {
        if (!shiftValidation.is_valid) {
          await client.query('ROLLBACK');
          return sendError(res, 400, shiftValidation.reason, { schedule_validation: shiftValidation });
        }
      } else if (
        shiftValidation.working_days?.length > 0 &&
        !shiftValidation.is_working_day
      ) {
        await client.query('ROLLBACK');
        return sendError(res, 400, shiftValidation.reason, { schedule_validation: shiftValidation });
      }

    }

    const isWfhDay = await isApprovedWfhDateForEmployee(
      client,
      employeeId,
      parsedDateTime.attendanceDate
    );

    if (verifyGeofence && !isWfhDay) {
      const geofenceCheck = await validateEmployeePunchGeofence(
        client,
        employeeId,
        location.latitude,
        location.longitude,
        actionType
      );
      if (!geofenceCheck.ok) {
        await client.query('ROLLBACK');
        return sendError(res, geofenceCheck.status, geofenceCheck.message, {
          work_location: geofenceCheck.geofence,
          distance_meters: geofenceCheck.distance_meters,
        });
      }
      workLocationId = geofenceCheck.geofence?.work_location_id ?? workLocationId;
      distanceMeters = geofenceCheck.distance_meters;
    }

    const previousPunches = getPunchesBeforeAttempt(punches, parsedDateTime.punchedAt);
    const state = buildPunchState(previousPunches);
    const transitionError = validatePunchTransition(actionType, previousPunches);
    if (transitionError) {
      await client.query('ROLLBACK');
      return sendError(res, 409, transitionError, {
        state,
        open_session_date: findActiveSessionDate(previousPunches),
      });
    }

    const chronologyError = validatePunchChronology(actionType, parsedDateTime.punchedAt, previousPunches);
    if (chronologyError) {
      await client.query('ROLLBACK');
      return sendError(res, 400, chronologyError.message, {
        state,
        open_session_date: findActiveSessionDate(previousPunches),
        clock_in_time: chronologyError.clock_in_time,
        break_start_time: chronologyError.break_start_time,
        attempted_punch_time: chronologyError.attempted_punch_time,
      });
    }

    const attendanceStatus = resolveAttendanceStatusForAction(
      actionType,
      employee,
      parsedDateTime.attendanceDate,
      parsedDateTime.punchedAt
    );

    const inserted = await client.query(
      `INSERT INTO attendance_punches (
         employee_id, attendance_date, action_type, punched_at, source, marked_by,
         work_location_id, latitude, longitude, remarks, attendance_status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, employee_id, attendance_date, action_type, punched_at, source, marked_by,
                 work_location_id, latitude, longitude, remarks, attendance_status, created_at`,
      [
        employeeId,
        parsedDateTime.attendanceDate,
        actionType,
        dateToPgUtcTimestamp(parsedDateTime.punchedAt),
        source,
        markedBy,
        workLocationId,
        location.latitude,
        location.longitude,
        req.body?.remarks ?? null,
        attendanceStatus,
      ]
    );

    dayPunches = await getPunchesForDate(client, employeeId, parsedDateTime.attendanceDate);
    let details = await buildPunchDetails(client, employeeId, parsedDateTime.attendanceDate);
    const updatedPunches = await getPunchesForEmployee(client, employeeId);
    if (details) {
      const nextState = buildPunchState(updatedPunches);
      details = applyAttendancePresentationToDetails(
        {
          ...details,
          state: nextState,
          latest_punch_id:
            updatedPunches[updatedPunches.length - 1]?.id
              ? Number(updatedPunches[updatedPunches.length - 1].id)
              : details.latest_punch_id,
        },
        employee,
        parsedDateTime.attendanceDate,
        dayPunches,
        { sortOrder: parsePunchListSortOrder(req.query) }
      );
    }
    await client.query('COMMIT');
    return sendSuccess(res, 201, 'Attendance punch recorded successfully.', {
      ...buildPunchResponseDateTime(parsedDateTime.punchedAt, parsedDateTime.attendanceDate),
      punch: formatPunchRowWithAttendanceStatus(
        inserted.rows[0],
        employee,
        parsedDateTime.attendanceDate
      ),
      distance_meters: distanceMeters,
      details,
      ...(autoClosedSession ? { auto_closed_session: autoClosedSession } : {}),
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create attendance punch error:', error);
    return sendError(res, 500, 'Something went wrong while recording attendance punch.');
  } finally {
    client.release();
  }
}

async function punchMyAttendance(req, res) {
  const auth = getRequestAuth(req);
  if (!auth) return sendError(res, 401, 'Authorization token is required.');

  try {
    const employeeId = await getEmployeeIdFromAuth(auth);
    if (!employeeId) return sendError(res, 404, 'No employee profile linked to this user.');
    return createPunch({
      req,
      res,
      employeeId,
      source: 'employee',
      markedBy: auth.userId,
      verifyLocation: true,
    });
  } catch (error) {
    console.error('Punch my attendance error:', error);
    return sendError(res, 500, 'Something went wrong while recording your attendance punch.');
  }
}

async function getMyPunchDetails(req, res) {
  const auth = getRequestAuth(req);
  if (!auth) return sendError(res, 401, 'Authorization token is required.');
  const attendanceDateParsed = parseRequiredDateInput(
    req.query?.attendance_date || req.query?.date || getTodayDateString(),
    'attendance_date'
  );
  if (attendanceDateParsed.error) {
    return sendError(res, 400, attendanceDateParsed.error);
  }
  const attendanceDate = attendanceDateParsed.value;
  const sortOrder = parsePunchListSortOrder(req.query);
  const listPagination = parsePunchDetailsPagination(req.query);
  if (listPagination.error) {
    return sendError(res, 400, listPagination.error);
  }

  const client = await pool.connect();
  try {
    const employeeId = await getEmployeeIdFromAuth(auth);
    if (!employeeId) return sendError(res, 404, 'No employee profile linked to this user.');

    const employee = await getEmployeeAttendanceProfile(client, employeeId);
    if (!employee) return sendError(res, 404, 'Employee not found.');

    const punches = await getPunchesForDate(client, employeeId, attendanceDate);
    const details = await buildPunchDetails(client, employeeId, attendanceDate);
    if (!details) return sendError(res, 404, 'Employee not found.');

    const payload = applyAttendancePresentationToDetails(
      details,
      employee,
      attendanceDate,
      punches,
      { sortOrder }
    );
    const paginated = paginatePunchList(payload.punches, listPagination);
    return sendSuccess(res, 200, 'Punch details fetched successfully.', {
      ...payload,
      punches: paginated.punches,
      pagination: paginated.pagination,
      no_pagination: paginated.no_pagination,
    });
  } catch (error) {
    console.error('Get my punch details error:', error);
    return sendError(res, 500, 'Something went wrong while fetching punch details.');
  } finally {
    client.release();
  }
}

async function getEmployeeLastPunchActivity(req, res) {
  const auth = getRequestAuth(req);
  if (!auth) return sendError(res, 401, 'Authorization token is required.');

  const scope = String(req.query?.scope || 'all').trim().toLowerCase();
  const attendanceDateRaw = req.query?.attendance_date || req.query?.date || getTodayDateString();
  let attendanceDate = getTodayDateString();
  if (scope === 'day') {
    const attendanceDateParsed = parseRequiredDateInput(attendanceDateRaw, 'attendance_date');
    if (attendanceDateParsed.error) {
      return sendError(res, 400, attendanceDateParsed.error);
    }
    attendanceDate = attendanceDateParsed.value;
  } else {
    const attendanceDateParsed = parseOptionalDateInput(attendanceDateRaw, 'attendance_date');
    if (attendanceDateParsed.error) {
      return sendError(res, 400, attendanceDateParsed.error);
    }
    attendanceDate = attendanceDateParsed.value || getTodayDateString();
  }

  const client = await pool.connect();
  try {
    const employeeId = await getEmployeeIdFromAuth(auth);
    if (!employeeId) return sendError(res, 404, 'No employee profile linked to this user.');

    let lastActivity = null;
    let resolvedDate = attendanceDate;
    let timelineState = null;

    if (scope === 'all') {
      const allPunches = await getPunchesForEmployee(client, employeeId);
      timelineState = buildPunchState(allPunches);
      lastActivity = allPunches.length > 0 ? allPunches[allPunches.length - 1] : null;
      if (lastActivity) {
        resolvedDate =
          findActiveSessionDate(allPunches) || toDateKey(lastActivity.attendance_date) || attendanceDate;
      }
    } else {
      const dayPunches = await getPunchesForDate(client, employeeId, attendanceDate);
      timelineState = buildPunchState(dayPunches);
      lastActivity = dayPunches.length > 0 ? dayPunches[dayPunches.length - 1] : null;
    }

    const employee = await getEmployeeAttendanceProfile(client, employeeId);
    const details = await buildPunchDetails(client, employeeId, resolvedDate);
    if (!details) return sendError(res, 404, 'Employee not found.');

    return sendSuccess(res, 200, 'Last punch activity fetched successfully.', {
      scope,
      attendance_date: resolvedDate,
      status: details.status,
      last_activity: lastActivity
        ? formatPunchRowWithAttendanceStatus(lastActivity, employee, resolvedDate)
        : null,
      state: timelineState || details.state,
      sessions: details.sessions,
      break_sessions: details.break_sessions,
      actual_work_minutes: details.actual_work_minutes,
      actual_work_hours: details.actual_work_hours,
      actual_break_minutes: details.actual_break_minutes,
      actual_break_hours: details.actual_break_hours,
      next_allowed_action: (timelineState || details.state)?.next_allowed_action ?? 'clock_in',
    });
  } catch (error) {
    console.error('Get employee last punch activity error:', error);
    return sendError(res, 500, 'Something went wrong while fetching last punch activity.');
  } finally {
    client.release();
  }
}

async function adminMarkAttendancePunch(req, res) {
  const auth = await requireAttendanceAdmin(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);
  const employeeId = parsePositiveInt(req.body?.employee_id);
  if (!employeeId) return sendError(res, 400, 'employee_id is required and must be a positive integer.');

  return createPunch({
    req,
    res,
    employeeId,
    source: 'admin',
    markedBy: auth.admin.id,
    verifyLocation: false,
  });
}

async function companyAdminMarkEmployeePunch(req, res) {
  const auth = await getAuthenticatedCompanyAdmin(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

  const employeeId = parsePositiveInt(req.body?.employee_id);
  if (!employeeId) {
    return sendError(res, 400, 'employee_id is required and must be a positive integer.');
  }

  const actionType = normalizePunchAction(req.body?.action_type ?? req.body?.action);
  if (!PUNCH_ACTIONS.has(actionType)) {
    return sendError(
      res,
      400,
      'action_type must be one of: clock_in, break_start, break_end, clock_out.'
    );
  }

  const punchedAtRaw = req.body?.punched_at ?? req.body?.punchedAt;
  const hasPunchedAt =
    punchedAtRaw !== undefined && punchedAtRaw !== null && String(punchedAtRaw).trim() !== '';
  const actionTimeRaw = req.body?.action_time ?? req.body?.punch_time ?? req.body?.time;
  const actionTime =
    actionTimeRaw !== undefined && actionTimeRaw !== null ? String(actionTimeRaw).trim() : '';

  const attendanceDateParsed = parseRequiredDateInput(
    req.body?.attendance_date || req.body?.date,
    'attendance_date'
  );
  if (attendanceDateParsed.error) {
    return sendError(res, 400, attendanceDateParsed.error);
  }
  const attendanceDate = attendanceDateParsed.value;

  if (hasPunchedAt) {
    const parsedPunchedAt = new Date(punchedAtRaw);
    if (Number.isNaN(parsedPunchedAt.getTime())) {
      return sendError(res, 400, 'punched_at must be a valid ISO date/time.');
    }
  } else {
    const timeValidation = validateDateAndTime(attendanceDate, actionTime, 'action_time');
    if (timeValidation) {
      return sendError(res, 400, timeValidation);
    }
  }

  try {
    const employeeResult = await pool.query(
      'SELECT id FROM employees WHERE id = $1 AND company_id = $2',
      [employeeId, auth.admin.company_id]
    );
    if (employeeResult.rowCount === 0) {
      return sendError(res, 404, 'Employee not found in your company.');
    }

    return createPunch({
      req,
      res,
      employeeId,
      source: 'admin',
      markedBy: auth.admin.id,
      verifyLocation: false,
      verifyGeofence: true,
    });
  } catch (error) {
    console.error('Company admin mark employee punch error:', error);
    return sendError(res, 500, 'Something went wrong while marking employee attendance.');
  }
}

async function adminGetAttendanceDetails(req, res) {
  const auth = await requireAttendanceAdmin(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

  const employeeId = parsePositiveInt(req.params.employee_id ?? req.query?.employee_id);
  if (!employeeId) return sendError(res, 400, 'employee_id must be a positive integer.');
  const attendanceDateParsed = parseRequiredDateInput(
    req.query?.attendance_date || req.query?.date || getTodayDateString(),
    'attendance_date'
  );
  if (attendanceDateParsed.error) {
    return sendError(res, 400, attendanceDateParsed.error);
  }
  const attendanceDate = attendanceDateParsed.value;

  const client = await pool.connect();
  try {
    const details = await buildPunchDetails(client, employeeId, attendanceDate);
    if (!details) return sendError(res, 404, 'Employee not found.');
    return sendSuccess(res, 200, 'Attendance details fetched successfully.', details);
  } catch (error) {
    console.error('Admin get attendance details error:', error);
    return sendError(res, 500, 'Something went wrong while fetching attendance details.');
  } finally {
    client.release();
  }
}

function parseMonth(value) {
  const month = String(value || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const monthNumber = Number(month.slice(5, 7));
  if (monthNumber < 1 || monthNumber > 12) return null;
  return month;
}

function daysInMonth(year, monthIndexOneBased) {
  return new Date(Date.UTC(year, monthIndexOneBased, 0)).getUTCDate();
}

function groupPunchesByEmployeeAndDate(punchRows = []) {
  const grouped = new Map();
  for (const punch of normalizePunchRows(punchRows)) {
    const employeeId = Number(punch.employee_id);
    const dateKey = toDateKey(punch.attendance_date);
    if (!employeeId || !dateKey) continue;
    if (!grouped.has(employeeId)) grouped.set(employeeId, new Map());
    const punchesByDate = grouped.get(employeeId);
    if (!punchesByDate.has(dateKey)) punchesByDate.set(dateKey, []);
    punchesByDate.get(dateKey).push(punch);
  }
  return grouped;
}

function addOneUtcDateKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function eachUtcDateKeyInRange(startKey, endKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startKey) || !/^\d{4}-\d{2}-\d{2}$/.test(endKey) || startKey > endKey) {
    return [];
  }
  const dates = [];
  let cursor = startKey;
  while (true) {
    dates.push(cursor);
    if (cursor === endKey) break;
    cursor = addOneUtcDateKey(cursor);
  }
  return dates;
}

/** Map employee_id → Set of YYYY-MM-DD keys covered by approved leave in range. */
async function fetchApprovedLeaveDateKeysByEmployee(client, companyId, employeeIds, startDate, endDate) {
  const byEmployee = new Map();
  if (!Array.isArray(employeeIds) || employeeIds.length === 0) return byEmployee;

  const result = await client.query(
    `SELECT lr.employee_id, lr.from_date, lr.to_date
     FROM leave_requests lr
     WHERE lr.company_id = $1
       AND lr.employee_id = ANY($2::bigint[])
       AND lr.status = 'approved'
       AND lr.to_date >= $3::date
       AND lr.from_date <= $4::date`,
    [companyId, employeeIds, startDate, endDate]
  );

  for (const row of result.rows) {
    const employeeId = Number(row.employee_id);
    const fromKey = toDateKey(row.from_date);
    const toKey = toDateKey(row.to_date);
    if (!employeeId || !fromKey || !toKey) continue;
    if (!byEmployee.has(employeeId)) byEmployee.set(employeeId, new Set());
    const leaveDates = byEmployee.get(employeeId);
    for (const dateKey of eachUtcDateKeyInRange(fromKey, toKey)) {
      if (dateKey >= startDate && dateKey <= endDate) {
        leaveDates.add(dateKey);
      }
    }
  }
  return byEmployee;
}

function resolveCalendarDayStatus({
  isHoliday,
  employee,
  dateKey,
  punches,
  isOnLeave,
}) {
  if (isHoliday) return 'holiday';
  const baseStatus = deriveDayAttendanceStatus(employee, dateKey, punches);
  // Holiday / Day Off win; approved leave wins over punches on working days.
  if (baseStatus === 'off_day') return 'off_day';
  if (isOnLeave) return 'on_leave';
  return baseStatus;
}

function buildEmployeeMonthCalendarRecords(employee, month, holidaysByDate, punchesByDate = new Map(), options = {}) {
  const sortOrder = options.sortOrder === 'asc' ? 'asc' : 'desc';
  const leaveDateKeys =
    options.leaveDateKeys instanceof Set ? options.leaveDateKeys : new Set(options.leaveDateKeys || []);
  const [year, monthNumber] = month.split('-').map(Number);
  const scheduled = buildScheduledDetails(employee);
  const scheduledWorkingDays = normalizeWorkingDays(
    employee.working_days || employee.attendance_schedule?.working_days
  );
  const today = getTodayDateString();
  const records = [];
  let totalPresentDays = 0;
  let totalHolidayDays = 0;
  let totalOnLeaveDays = 0;
  let totalWorkMinutes = 0;
  const countableDates = [];

  for (let day = 1; day <= daysInMonth(year, monthNumber); day += 1) {
    const dateKey = `${month}-${String(day).padStart(2, '0')}`;
    const weekday = getWeekdayName(dateKey);
    const isWorkingDay = scheduledWorkingDays.length === 0 || scheduledWorkingDays.includes(weekday);
    const dayHolidays = holidaysByDate.get(dateKey) || [];
    const isHoliday = dayHolidays.length > 0;
    const isOnLeave = leaveDateKeys.has(dateKey);
    const punches = punchesByDate.get(dateKey) || [];
    const dayStatus = resolveCalendarDayStatus({
      isHoliday,
      employee,
      dateKey,
      punches,
      isOnLeave,
    });
    const shouldCountForSummary =
      dateKey <= today && isWorkingDay && !isHoliday && dayStatus !== 'on_leave';
    if (shouldCountForSummary) {
      countableDates.push(dateKey);
    }
    if (dateKey <= today && isHoliday) {
      totalHolidayDays += 1;
    }
    if (dateKey <= today && dayStatus === 'on_leave') {
      totalOnLeaveDays += 1;
    }

    const metrics = buildPunchMetrics(punches);
    const dayClockIn = findLatestClockIn(punches);
    const shiftValidation = alignShiftValidationWithStoredClockIn(
      buildShiftValidation(employee, dateKey, dayClockIn?.punched_at),
      dayClockIn
    );
    if (punches.length > 0 && shouldCountForSummary) {
      totalPresentDays += 1;
    }
    totalWorkMinutes += Number(metrics.actual_work_minutes || 0);

    const record = {
      attendance_date: dateKey,
      status: dayStatus,
      scheduled_work_minutes: scheduled.scheduled_work_minutes,
      scheduled_work_hours: scheduled.scheduled_work_hours,
      scheduled_break_minutes: scheduled.scheduled_break_minutes,
      scheduled_break_hours: scheduled.scheduled_break_hours,
      assigned_shift: scheduled.assigned_shift,
      work_location: scheduled.work_location,
      schedule_validation: {
        ...shiftValidation,
        attendance_status: dayStatus,
        is_holiday: isHoliday,
        is_on_leave: dayStatus === 'on_leave',
      },
      punches: sortPunchesForDisplay(
        punches.map((punch) => formatPunchRowWithAttendanceStatus(punch, employee, dateKey)),
        sortOrder
      ),
      sessions: enrichSessionsWithAttendanceStatus(metrics.sessions, employee, dateKey, punches),
      break_sessions: metrics.break_sessions,
      actual_work_minutes: metrics.actual_work_minutes,
      actual_work_hours: metrics.actual_work_hours,
      actual_break_minutes: metrics.actual_break_minutes,
      actual_break_hours: metrics.actual_break_hours,
    };
    if (isHoliday) {
      record.holidays = dayHolidays;
    }
    records.push(record);
  }

  const totalAbsentDays = Math.max(countableDates.length - totalPresentDays, 0);
  return {
    records,
    scheduled,
    scheduled_working_days: scheduledWorkingDays,
    summary: {
      total_days_present: totalPresentDays,
      total_days_absent: totalAbsentDays,
      total_holiday_days: totalHolidayDays,
      total_on_leave_days: totalOnLeaveDays,
      total_hours_worked: Number((totalWorkMinutes / 60).toFixed(2)),
      average_daily_hours:
        totalPresentDays > 0 ? Number((totalWorkMinutes / 60 / totalPresentDays).toFixed(2)) : 0,
    },
  };
}

function buildCompanyCalendarAggregateSummary(calendars = []) {
  const summary = {
    total_employees: calendars.length,
    total_days_present: 0,
    total_days_absent: 0,
    total_holiday_days: 0,
    total_on_leave_days: 0,
    total_hours_worked: 0,
    present_days: 0,
    late_days: 0,
    absent_days: 0,
    off_day_days: 0,
    holiday_days: 0,
    on_leave_days: 0,
  };

  for (const calendar of calendars) {
    summary.total_days_present += Number(calendar.summary?.total_days_present || 0);
    summary.total_days_absent += Number(calendar.summary?.total_days_absent || 0);
    summary.total_holiday_days += Number(calendar.summary?.total_holiday_days || 0);
    summary.total_on_leave_days += Number(calendar.summary?.total_on_leave_days || 0);
    summary.total_hours_worked += Number(calendar.summary?.total_hours_worked || 0);

    for (const record of calendar.records || []) {
      const status = String(record.status || '').toLowerCase();
      if (status === 'present') summary.present_days += 1;
      else if (status === 'late') summary.late_days += 1;
      else if (status === 'absent') summary.absent_days += 1;
      else if (status === 'off_day') summary.off_day_days += 1;
      else if (status === 'holiday') summary.holiday_days += 1;
      else if (status === 'on_leave') summary.on_leave_days += 1;
    }
  }

  summary.total_hours_worked = Number(summary.total_hours_worked.toFixed(2));
  return summary;
}

/** Employees always see their own month; admins may pass employee_id for another user. */
async function resolveCalendarEmployeeId(req, auth) {
  const authEmployeeId = await getEmployeeIdFromAuth(auth);
  const requestedEmployeeId = parsePositiveInt(req.query?.employee_id);

  if (requestedEmployeeId) {
    const adminCheck = await requireAttendanceAdmin(req);
    if (!adminCheck.error) {
      return { employeeId: requestedEmployeeId };
    }
    if (!authEmployeeId) {
      return { error: [404, 'No employee profile linked to this user.'] };
    }
    if (requestedEmployeeId !== authEmployeeId) {
      return { error: [403, 'You can only view your own attendance calendar.'] };
    }
    return { employeeId: authEmployeeId };
  }

  if (!authEmployeeId) {
    return { error: [404, 'No employee profile linked to this user.'] };
  }
  return { employeeId: authEmployeeId };
}

async function getAttendanceCalendar(req, res) {
  const auth = getRequestAuth(req);
  if (!auth) return sendError(res, 401, 'Authorization token is required.');

  const month = parseMonth(req.query?.month || getTodayDateString().slice(0, 7));
  if (!month) return sendError(res, 400, 'month must be in YYYY-MM format.');
  const sortOrder = parsePunchListSortOrder(req.query);

  const resolved = await resolveCalendarEmployeeId(req, auth);
  if (resolved.error) return sendError(res, resolved.error[0], resolved.error[1]);
  const employeeId = resolved.employeeId;

  const [year, monthNumber] = month.split('-').map(Number);
  const startDate = `${month}-01`;
  const endDate = `${month}-${String(daysInMonth(year, monthNumber)).padStart(2, '0')}`;

  const client = await pool.connect();
  try {
    const employee = await getEmployeeAttendanceProfile(client, employeeId);
    if (!employee) return sendError(res, 404, 'Employee not found.');

    const holidayResult = await holidayService.getCompanyHolidaysForMonth(
      employee.company_id,
      month
    );
    if (holidayResult.error) {
      return sendError(res, 400, holidayResult.error);
    }
    const holidaysByDate = holidayResult.holidaysByDate || new Map();

    const punchesResult = await client.query(
      `SELECT id, employee_id, attendance_date, action_type, punched_at, source, marked_by,
              work_location_id, latitude, longitude, remarks, attendance_status, created_at
       FROM attendance_punches
       WHERE employee_id = $1
         AND attendance_date >= $2
         AND attendance_date <= $3
       ORDER BY attendance_date ASC, created_at DESC, id DESC`,
      [employeeId, startDate, endDate]
    );

    const punchesByDate = new Map();
    for (const punch of normalizePunchRows(punchesResult.rows)) {
      const dateKey = toDateKey(punch.attendance_date);
      if (!dateKey) continue;
      if (!punchesByDate.has(dateKey)) punchesByDate.set(dateKey, []);
      punchesByDate.get(dateKey).push(punch);
    }

    const leaveByEmployee = await fetchApprovedLeaveDateKeysByEmployee(
      client,
      employee.company_id,
      [employeeId],
      startDate,
      endDate
    );
    const leaveDateKeys = leaveByEmployee.get(Number(employeeId)) || new Set();

    const calendarData = buildEmployeeMonthCalendarRecords(
      employee,
      month,
      holidaysByDate,
      punchesByDate,
      { sortOrder, leaveDateKeys }
    );

    return sendSuccess(res, 200, 'Attendance calendar fetched successfully.', {
      employee: mapCompanyEmployeeSummary(employee),
      month,
      sort: sortOrder,
      scheduled_working_days: calendarData.scheduled_working_days,
      holidays: holidayResult.holidays || [],
      records: calendarData.records,
      summary: calendarData.summary,
    });
  } catch (error) {
    console.error('Get attendance calendar error:', error);
    return sendError(res, 500, 'Something went wrong while fetching attendance calendar.');
  } finally {
    client.release();
  }
}

async function getCompanyAdminAttendanceCalendar(req, res) {
  const auth = await getAuthenticatedCompanyAdmin(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

  const month = parseMonth(req.query?.month || getTodayDateString().slice(0, 7));
  if (!month) return sendError(res, 400, 'month must be in YYYY-MM format.');

  const filters = parseCompanyCalendarFilters(req.query);
  if (filters.error) return sendError(res, 400, filters.error);
  const sortOrder = parsePunchListSortOrder(req.query);

  const { page, limit, offset } = parsePagination(req.query, {
    defaultPage: 1,
    defaultLimit: 50,
    maxLimit: 200,
  });

  const [year, monthNumber] = month.split('-').map(Number);
  const startDate = `${month}-01`;
  const endDate = `${month}-${String(daysInMonth(year, monthNumber)).padStart(2, '0')}`;

  const client = await pool.connect();
  try {
    const companyId = Number(auth.admin.company_id);
    const whereParts = ['e.company_id = $1'];
    const values = [companyId];
    appendCompanyEmployeeAttendanceFilters(whereParts, values, filters);

    const whereClause = whereParts.join(' AND ');
    const employeesResult = await client.query(
      `SELECT ${COMPANY_EMPLOYEE_ATTENDANCE_SELECT}
       FROM employees e
       LEFT JOIN companies c ON c.id = e.company_id
       LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
       LEFT JOIN departments d ON d.id = ejd.department_id
       LEFT JOIN designations des ON des.id = ejd.designation_id
       LEFT JOIN attendance_location_settings wl ON wl.id = ejd.work_location_id
       LEFT JOIN shifts s ON s.id = ejd.shift_id
       WHERE ${whereClause}
       ORDER BY e.first_name ASC, e.last_name ASC, e.id ASC`,
      values
    );

    const employeeRows = employeesResult.rows;
    const employeeIds = employeeRows.map((row) => Number(row.id));
    let punchesGrouped = new Map();

    if (employeeIds.length > 0) {
      const punchesResult = await client.query(
        `SELECT id, employee_id, attendance_date, action_type, punched_at, source, marked_by,
                work_location_id, latitude, longitude, remarks, attendance_status, created_at
         FROM attendance_punches
         WHERE employee_id = ANY($1::bigint[])
           AND attendance_date >= $2
           AND attendance_date <= $3
         ORDER BY employee_id ASC, attendance_date ASC, created_at DESC, id DESC`,
        [employeeIds, startDate, endDate]
      );
      punchesGrouped = groupPunchesByEmployeeAndDate(punchesResult.rows);
    }

    const holidayResult = await holidayService.getCompanyHolidaysForMonth(companyId, month);
    if (holidayResult.error) {
      return sendError(res, 400, holidayResult.error);
    }
    const holidaysByDate = holidayResult.holidaysByDate || new Map();

    const leaveByEmployee = await fetchApprovedLeaveDateKeysByEmployee(
      client,
      companyId,
      employeeIds,
      startDate,
      endDate
    );

    let calendars = employeeRows.map((employeeRow) => {
      const employeeId = Number(employeeRow.id);
      const punchesByDate = punchesGrouped.get(employeeId) || new Map();
      const leaveDateKeys = leaveByEmployee.get(employeeId) || new Set();
      const calendarData = buildEmployeeMonthCalendarRecords(
        employeeRow,
        month,
        holidaysByDate,
        punchesByDate,
        { sortOrder, leaveDateKeys }
      );

      return {
        employee: mapCompanyEmployeeSummary(employeeRow),
        month,
        scheduled_working_days: calendarData.scheduled_working_days,
        records: calendarData.records,
        summary: calendarData.summary,
      };
    });

    if (filters.statusFilter) {
      calendars = calendars
        .map((calendar) => ({
          ...calendar,
          records: calendar.records.filter(
            (record) => String(record.status || '').toLowerCase() === filters.statusFilter
          ),
        }))
        .filter((calendar) => calendar.records.length > 0);
    }

    calendars = sortCompanyCalendarsByCreatedAt(calendars, sortOrder);

    const summary = buildCompanyCalendarAggregateSummary(calendars);
    const total = calendars.length;
    const paginatedCalendars = calendars.slice(offset, offset + limit);

    return sendSuccess(res, 200, 'Company attendance calendar fetched successfully.', {
      company_id: companyId,
      month,
      sort: sortOrder,
      filters: {
        employee_id: filters.employeeId,
        department_id: filters.departmentId,
        designation_id: filters.designationId,
        shift_id: filters.shiftId,
        work_location_id: filters.workLocationId,
        status: filters.statusFilter || null,
        search: filters.search || null,
      },
      holidays: holidayResult.holidays || [],
      calendars: paginatedCalendars,
      summary,
      pagination: buildPaginationMeta({ page, limit, total }),
    });
  } catch (error) {
    console.error('Get company admin attendance calendar error:', error);
    return sendError(res, 500, 'Something went wrong while fetching company attendance calendar.');
  } finally {
    client.release();
  }
}

async function getCompanyAdminAttendanceHistory(req, res) {
  const auth = await getAuthenticatedCompanyAdmin(req);
  if (auth.error) return sendError(res, auth.error[0], auth.error[1]);

  const dateRange = parseCompanyHistoryDateRange(req.query);
  if (dateRange.error) return sendError(res, 400, dateRange.error);

  const filters = parseCompanyCalendarFilters(req.query);
  if (filters.error) return sendError(res, 400, filters.error);

  const sort = parseCompanyHistorySort(req.query);
  if (sort.error) return sendError(res, 400, sort.error);

  const includeWithoutPunches = parseBooleanQueryFlag(
    req.query?.include_without_punches ?? req.query?.include_empty_days,
    false
  );
  if (includeWithoutPunches === null) {
    return sendError(res, 400, 'include_without_punches must be true or false.');
  }

  const { page, limit, offset } = parsePagination(req.query, {
    defaultPage: 1,
    defaultLimit: 50,
    maxLimit: 200,
  });

  const client = await pool.connect();
  try {
    const companyId = Number(auth.admin.company_id);
    const { dateFrom, dateTo } = dateRange;
    const whereParts = ['e.company_id = $1'];
    const values = [companyId];
    appendCompanyEmployeeAttendanceFilters(whereParts, values, filters);

    const whereClause = whereParts.join(' AND ');
    const employeesResult = await client.query(
      `SELECT ${COMPANY_EMPLOYEE_ATTENDANCE_SELECT}
       FROM employees e
       LEFT JOIN companies c ON c.id = e.company_id
       LEFT JOIN employee_job_details ejd ON ejd.employee_id = e.id
       LEFT JOIN departments d ON d.id = ejd.department_id
       LEFT JOIN designations des ON des.id = ejd.designation_id
       LEFT JOIN attendance_location_settings wl ON wl.id = ejd.work_location_id
       LEFT JOIN shifts s ON s.id = ejd.shift_id
       WHERE ${whereClause}
       ORDER BY e.first_name ASC, e.last_name ASC, e.id ASC`,
      values
    );

    const employeeRows = employeesResult.rows;
    const employeeIds = employeeRows.map((row) => Number(row.id));
    let punchesGrouped = new Map();

    if (employeeIds.length > 0) {
      const punchesResult = await client.query(
        `SELECT id, employee_id, attendance_date, action_type, punched_at, source, marked_by,
                work_location_id, latitude, longitude, remarks, attendance_status, created_at
         FROM attendance_punches
         WHERE employee_id = ANY($1::bigint[])
           AND attendance_date >= $2
           AND attendance_date <= $3
         ORDER BY attendance_date DESC, created_at DESC, id DESC`,
        [employeeIds, dateFrom, dateTo]
      );
      punchesGrouped = groupPunchesByEmployeeAndDate(punchesResult.rows);
    }

    const punchSortOrder = parsePunchListSortOrder(req.query);
    const dateKeys = listDateKeysBetween(dateFrom, dateTo);
    let records = [];

    for (const employeeRow of employeeRows) {
      const punchesByDate = punchesGrouped.get(Number(employeeRow.id)) || new Map();
      const datesToBuild = includeWithoutPunches
        ? dateKeys
        : [...punchesByDate.keys()].sort((a, b) => b.localeCompare(a));

      for (const attendanceDate of datesToBuild) {
        if (attendanceDate < dateFrom || attendanceDate > dateTo) continue;
        const dayPunches = punchesByDate.get(attendanceDate) || [];
        if (!includeWithoutPunches && dayPunches.length === 0) continue;

        records.push(
          buildCompanyHistoryDayRecord(employeeRow, attendanceDate, dayPunches, {
            sortOrder: punchSortOrder,
          })
        );
      }
    }

    if (filters.statusFilter) {
      records = records.filter(
        (record) => String(record.status || '').toLowerCase() === filters.statusFilter
      );
    }

    records = sortCompanyHistoryRecords(records, sort.sortBy, sort.sortOrder);

    const summary = buildCompanyHistorySummary(records);
    const total = records.length;
    const paginatedRecords = records.slice(offset, offset + limit);

    return sendSuccess(res, 200, 'Company attendance history fetched successfully.', {
      company_id: companyId,
      date_from: dateFrom,
      date_to: dateTo,
      sort_by: sort.sortBy,
      sort: sort.sortOrder,
      include_without_punches: includeWithoutPunches,
      filters: {
        employee_id: filters.employeeId,
        department_id: filters.departmentId,
        designation_id: filters.designationId,
        shift_id: filters.shiftId,
        work_location_id: filters.workLocationId,
        status: filters.statusFilter || null,
        search: filters.search || null,
      },
      records: paginatedRecords,
      summary,
      pagination: buildPaginationMeta({ page, limit, total }),
    });
  } catch (error) {
    console.error('Get company admin attendance history error:', error);
    return sendError(res, 500, 'Something went wrong while fetching company attendance history.');
  } finally {
    client.release();
  }
}

async function getAttendances(req, res) {
  const { page, limit, offset } = parsePagination(req.query, {
    defaultPage: 1,
    defaultLimit: 10,
    maxLimit: 100,
  });

  const {
    employee_id,
    status,
    approval_status,
    work_mode,
    date_from,
    date_to,
    name,
    search,
  } = req.query || {};

  const whereParts = [];
  const values = [];
  const addParam = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (employee_id !== undefined && employee_id !== '') {
    const parsedEmployeeId = Number(employee_id);
    if (!Number.isInteger(parsedEmployeeId) || parsedEmployeeId <= 0) {
      return sendError(res, 400, 'employee_id must be a valid positive integer.');
    }
    whereParts.push(`a.employee_id = ${addParam(parsedEmployeeId)}`);
  }

  if (status) {
    if (!ALLOWED_STATUS.has(status)) {
      return sendError(res, 400, 'status must be one of: present, late, absent.');
    }
    whereParts.push(`a.status = ${addParam(status)}`);
  }

  if (approval_status) {
    if (!ALLOWED_APPROVAL_STATUS.has(approval_status)) {
      return sendError(res, 400, 'approval_status must be one of: pending, approved, rejected.');
    }
    whereParts.push(`a.approval_status = ${addParam(approval_status)}`);
  }

  if (work_mode) {
    if (!ALLOWED_WORK_MODE.has(work_mode)) {
      return sendError(res, 400, 'work_mode must be one of: office, remote.');
    }
    whereParts.push(`a.work_mode = ${addParam(work_mode)}`);
  }

  const dateFromParsed = date_from ? parseRequiredDateInput(date_from, 'date_from') : null;
  if (dateFromParsed?.error) {
    return sendError(res, 400, dateFromParsed.error);
  }
  const dateToParsed = date_to ? parseRequiredDateInput(date_to, 'date_to') : null;
  if (dateToParsed?.error) {
    return sendError(res, 400, dateToParsed.error);
  }

  if (dateFromParsed?.value) {
    whereParts.push(`a.attendance_date >= ${addParam(dateFromParsed.value)}`);
  }

  if (dateToParsed?.value) {
    whereParts.push(`a.attendance_date <= ${addParam(dateToParsed.value)}`);
  }

  if (
    dateFromParsed?.value &&
    dateToParsed?.value &&
    dateFromParsed.value > dateToParsed.value
  ) {
    return sendError(res, 400, 'date_from cannot be greater than date_to.');
  }

  const searchValue = String(search || name || '').trim();
  if (searchValue) {
    const searchParam = addParam(`%${searchValue}%`);
    whereParts.push(`(
      e.first_name ILIKE ${searchParam}
      OR e.last_name ILIKE ${searchParam}
      OR CONCAT(e.first_name, ' ', e.last_name) ILIKE ${searchParam}
      OR e.employee_code ILIKE ${searchParam}
      OR COALESCE(e.employee_id, '') ILIKE ${searchParam}
    )`);
  }

  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const listParams = [...values, limit, offset];
  const limitParam = `$${values.length + 1}`;
  const offsetParam = `$${values.length + 2}`;

  try {
    const [listResult, countResult] = await Promise.all([
      pool.query(
        `SELECT
          a.id,
          a.employee_id,
          a.attendance_date,
          a.check_in_time,
          a.check_out_time,
          a.work_hours,
          a.status,
          a.work_mode,
          a.approval_status,
          a.source,
          a.remarks,
          a.rejection_reason,
          a.approved_by,
          a.approved_at,
          a.created_at,
          a.check_in_latitude,
          a.check_in_longitude,
          a.check_out_latitude,
          a.check_out_longitude,
          als.id AS location_setting_id,
          als.latitude AS allotted_latitude,
          als.longitude AS allotted_longitude,
          als.radius_meters AS allotted_radius_meters,
          als.shift_start AS allotted_shift_start,
          als.shift_end AS allotted_shift_end,
          als.break_minutes AS allotted_break_minutes,
          als.grace_minutes AS allotted_grace_minutes,
          CASE
            WHEN a.check_in_latitude IS NULL
              OR a.check_in_longitude IS NULL
              OR als.latitude IS NULL
              OR als.longitude IS NULL
            THEN NULL
            ELSE ROUND(
              (
                6371000 * 2 * ASIN(
                  SQRT(
                    POWER(SIN(RADIANS((a.check_in_latitude - als.latitude) / 2)), 2) +
                    COS(RADIANS(als.latitude)) * COS(RADIANS(a.check_in_latitude)) *
                    POWER(SIN(RADIANS((a.check_in_longitude - als.longitude) / 2)), 2)
                  )
                )
              )::numeric,
              2
            )
          END AS check_in_distance_meters,
          CASE
            WHEN a.check_in_latitude IS NULL
              OR a.check_in_longitude IS NULL
              OR als.latitude IS NULL
              OR als.longitude IS NULL
              OR als.radius_meters IS NULL
            THEN NULL
            ELSE (
              6371000 * 2 * ASIN(
                SQRT(
                  POWER(SIN(RADIANS((a.check_in_latitude - als.latitude) / 2)), 2) +
                  COS(RADIANS(als.latitude)) * COS(RADIANS(a.check_in_latitude)) *
                  POWER(SIN(RADIANS((a.check_in_longitude - als.longitude) / 2)), 2)
                )
              )
            ) <= als.radius_meters
          END AS is_within_allotted_radius,
          e.first_name,
          e.last_name,
          e.employee_code,
          e.work_email
        FROM attendance a
        INNER JOIN employees e ON e.id = a.employee_id
        LEFT JOIN attendance_location_settings als
          ON als.id = a.work_location_id
          OR (a.work_location_id IS NULL AND als.employee_id = a.employee_id)
        ${whereClause}
        ORDER BY a.attendance_date DESC, a.id DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
        listParams
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM attendance a
         INNER JOIN employees e ON e.id = a.employee_id
         ${whereClause}`,
        values
      ),
    ]);

    const total = countResult.rows[0].total || 0;
    return sendSuccess(res, 200, 'Attendance records fetched successfully.', {
      attendances: listResult.rows,
      pagination: buildPaginationMeta({ page, limit, total }),
    });
  } catch (error) {
    console.error('Get attendance list error:', error);
    return sendError(res, 500, 'Something went wrong while fetching attendance records.');
  }
}

async function getAttendanceById(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return sendError(res, 400, 'Please provide a valid attendance id.');
  }

  try {
    const result = await pool.query(
      `SELECT
        a.id,
        a.employee_id,
        a.attendance_date,
        a.check_in_time,
        a.check_out_time,
        a.work_hours,
        a.status,
        a.work_mode,
        a.approval_status,
        a.source,
        a.remarks,
        a.rejection_reason,
        a.approved_by,
        a.approved_at,
        a.created_at,
        a.check_in_latitude,
        a.check_in_longitude,
        a.check_out_latitude,
        a.check_out_longitude,
        als.id AS location_setting_id,
        als.latitude AS allotted_latitude,
        als.longitude AS allotted_longitude,
        als.radius_meters AS allotted_radius_meters,
        als.shift_start AS allotted_shift_start,
        als.shift_end AS allotted_shift_end,
        als.break_minutes AS allotted_break_minutes,
        als.grace_minutes AS allotted_grace_minutes,
        CASE
          WHEN a.check_in_latitude IS NULL
            OR a.check_in_longitude IS NULL
            OR als.latitude IS NULL
            OR als.longitude IS NULL
          THEN NULL
          ELSE ROUND(
            (
              6371000 * 2 * ASIN(
                SQRT(
                  POWER(SIN(RADIANS((a.check_in_latitude - als.latitude) / 2)), 2) +
                  COS(RADIANS(als.latitude)) * COS(RADIANS(a.check_in_latitude)) *
                  POWER(SIN(RADIANS((a.check_in_longitude - als.longitude) / 2)), 2)
                )
              )
            )::numeric,
            2
          )
        END AS check_in_distance_meters,
        CASE
          WHEN a.check_in_latitude IS NULL
            OR a.check_in_longitude IS NULL
            OR als.latitude IS NULL
            OR als.longitude IS NULL
            OR als.radius_meters IS NULL
          THEN NULL
          ELSE (
            6371000 * 2 * ASIN(
              SQRT(
                POWER(SIN(RADIANS((a.check_in_latitude - als.latitude) / 2)), 2) +
                COS(RADIANS(als.latitude)) * COS(RADIANS(a.check_in_latitude)) *
                POWER(SIN(RADIANS((a.check_in_longitude - als.longitude) / 2)), 2)
              )
            )
          ) <= als.radius_meters
        END AS is_within_allotted_radius,
        e.first_name,
        e.last_name,
        e.employee_code,
        e.work_email
      FROM attendance a
      INNER JOIN employees e ON e.id = a.employee_id
      LEFT JOIN attendance_location_settings als
        ON als.id = a.work_location_id
        OR (a.work_location_id IS NULL AND als.employee_id = a.employee_id)
      WHERE a.id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, 'Attendance record not found.');
    }

    return sendSuccess(
      res,
      200,
      'Attendance details fetched successfully.',
      result.rows[0]
    );
  } catch (error) {
    console.error('Get attendance by id error:', error);
    return sendError(res, 500, 'Something went wrong while fetching attendance details.');
  }
}

async function approveAttendance(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return sendError(res, 400, 'Please provide a valid attendance id.');
  }

  const approvedByRaw = req.body?.approved_by;
  const approvedBy =
    approvedByRaw === undefined || approvedByRaw === null || approvedByRaw === ''
      ? null
      : Number(approvedByRaw);

  if (approvedBy !== null && (!Number.isInteger(approvedBy) || approvedBy <= 0)) {
    return sendError(res, 400, 'approved_by must be a valid positive integer.');
  }

  try {
    const existingResult = await pool.query(
      'SELECT id, approval_status FROM attendance WHERE id = $1',
      [id]
    );

    if (existingResult.rowCount === 0) {
      return sendError(res, 404, 'Attendance record not found.');
    }

    if (existingResult.rows[0].approval_status === 'approved') {
      return sendError(res, 409, 'Attendance record is already approved.');
    }

    const updateResult = await pool.query(
      `UPDATE attendance
       SET approval_status = 'approved',
           rejection_reason = NULL,
           approved_by = $1,
           approved_at = NOW()
       WHERE id = $2
       RETURNING id, employee_id, attendance_date, check_in_time, check_out_time, work_hours, status, work_mode, approval_status, source, remarks, rejection_reason, approved_by, approved_at, created_at`,
      [approvedBy, id]
    );

    return sendSuccess(
      res,
      200,
      'Attendance approved successfully.',
      updateResult.rows[0]
    );
  } catch (error) {
    console.error('Approve attendance error:', error);
    return sendError(res, 500, 'Something went wrong while approving attendance.');
  }
}

async function rejectAttendance(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return sendError(res, 400, 'Please provide a valid attendance id.');
  }

  const reason = String(req.body?.reason || '').trim();
  if (!reason) {
    return sendError(res, 400, 'reason is required.');
  }

  const approvedByRaw = req.body?.approved_by;
  const approvedBy =
    approvedByRaw === undefined || approvedByRaw === null || approvedByRaw === ''
      ? null
      : Number(approvedByRaw);

  if (approvedBy !== null && (!Number.isInteger(approvedBy) || approvedBy <= 0)) {
    return sendError(res, 400, 'approved_by must be a valid positive integer.');
  }

  try {
    const existingResult = await pool.query(
      'SELECT id, approval_status FROM attendance WHERE id = $1',
      [id]
    );

    if (existingResult.rowCount === 0) {
      return sendError(res, 404, 'Attendance record not found.');
    }

    if (existingResult.rows[0].approval_status === 'rejected') {
      return sendError(res, 409, 'Attendance record is already rejected.');
    }

    const updateResult = await pool.query(
      `UPDATE attendance
       SET approval_status = 'rejected',
           rejection_reason = $1,
           approved_by = $2,
           approved_at = NOW()
       WHERE id = $3
       RETURNING id, employee_id, attendance_date, check_in_time, check_out_time, work_hours, status, work_mode, approval_status, source, remarks, rejection_reason, approved_by, approved_at, created_at`,
      [reason, approvedBy, id]
    );

    return sendSuccess(
      res,
      200,
      'Attendance rejected successfully.',
      updateResult.rows[0]
    );
  } catch (error) {
    console.error('Reject attendance error:', error);
    return sendError(res, 500, 'Something went wrong while rejecting attendance.');
  }
}

async function upsertAttendanceLocationSettings(req, res) {
  const {
    employee_id,
    latitude,
    longitude,
    radius_meters,
    shift_start,
    shift_end,
    break_minutes = 0,
    grace_minutes = 0,
  } = req.body || {};

  const parsedEmployeeId = Number(employee_id);
  if (!Number.isInteger(parsedEmployeeId) || parsedEmployeeId <= 0) {
    return sendError(res, 400, 'Please provide a valid employee_id.');
  }

  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return sendError(res, 400, 'latitude must be a number between -90 and 90.');
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return sendError(res, 400, 'longitude must be a number between -180 and 180.');
  }

  let radius = radius_meters === undefined || radius_meters === null ? DEFAULT_GEOFENCE_RADIUS_METERS : Number(radius_meters);
  if (!Number.isInteger(radius) || radius < 1 || radius > 50000) {
    return sendError(res, 400, 'radius_meters must be an integer between 1 and 50000.');
  }

  if (!shift_start || !TIME_REGEX.test(String(shift_start))) {
    return sendError(res, 400, 'shift_start is required and must be in HH:MM format.');
  }
  if (!shift_end || !TIME_REGEX.test(String(shift_end))) {
    return sendError(res, 400, 'shift_end is required and must be in HH:MM format.');
  }

  const br = Number(break_minutes);
  const gr = Number(grace_minutes);
  if (!Number.isInteger(br) || br < 0 || br > 480) {
    return sendError(res, 400, 'break_minutes must be an integer between 0 and 480.');
  }
  if (!Number.isInteger(gr) || gr < 0 || gr > 240) {
    return sendError(res, 400, 'grace_minutes must be an integer between 0 and 240.');
  }

  try {
    const employeeResult = await pool.query('SELECT id FROM employees WHERE id = $1', [
      parsedEmployeeId,
    ]);
    if (employeeResult.rowCount === 0) {
      return sendError(res, 404, 'Employee not found.');
    }

    const result = await pool.query(
      `INSERT INTO attendance_location_settings (
        employee_id,
        latitude,
        longitude,
        radius_meters,
        shift_start,
        shift_end,
        break_minutes,
        grace_minutes,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5::TIME, $6::TIME, $7, $8, NOW())
      ON CONFLICT (employee_id) DO UPDATE SET
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        radius_meters = EXCLUDED.radius_meters,
        shift_start = EXCLUDED.shift_start,
        shift_end = EXCLUDED.shift_end,
        break_minutes = EXCLUDED.break_minutes,
        grace_minutes = EXCLUDED.grace_minutes,
        updated_at = NOW()
      RETURNING id, employee_id, latitude, longitude, radius_meters,
                shift_start, shift_end, break_minutes, grace_minutes, created_at, updated_at`,
      [parsedEmployeeId, lat, lng, radius, shift_start, shift_end, br, gr]
    );

    return sendSuccess(res, 200, 'Attendance location settings saved.', result.rows[0]);
  } catch (error) {
    console.error('Upsert attendance location settings error:', error);
    return sendError(res, 500, 'Something went wrong while saving location settings.');
  }
}

async function getAttendanceLocationSettings(req, res) {
  const employeeIdRaw = req.query?.employee_id;
  const parsedEmployeeId = Number(employeeIdRaw);
  if (
    employeeIdRaw === undefined ||
    employeeIdRaw === null ||
    employeeIdRaw === '' ||
    !Number.isInteger(parsedEmployeeId) ||
    parsedEmployeeId <= 0
  ) {
    return sendError(res, 400, 'Query parameter employee_id is required and must be a positive integer.');
  }

  try {
    const result = await pool.query(
      `SELECT id, employee_id, latitude, longitude, radius_meters,
              shift_start, shift_end, break_minutes, grace_minutes, created_at, updated_at
       FROM attendance_location_settings
       WHERE employee_id = $1`,
      [parsedEmployeeId]
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, 'No attendance location settings found for this employee.');
    }

    return sendSuccess(res, 200, 'Attendance location settings retrieved.', result.rows[0]);
  } catch (error) {
    console.error('Get attendance location settings error:', error);
    return sendError(res, 500, 'Something went wrong while fetching location settings.');
  }
}

module.exports = {
  getAttendanceModes,
  markAttendance,
  markMyAttendance,
  clockInMyAttendance,
  breakInMyAttendance,
  breakOutMyAttendance,
  clockOutMyAttendance,
  getMyTodayAttendanceStatus,
  punchMyAttendance,
  getMyPunchDetails,
  getEmployeeLastPunchActivity,
  adminMarkAttendancePunch,
  adminGetAttendanceDetails,
  getAttendanceCalendar,
  upsertAttendanceLocationSettings,
  getAttendanceLocationSettings,
  getAttendances,
  getAttendanceById,
  approveAttendance,
  rejectAttendance,
  getCompanyAdminTodayLogs,
  getCompanyAdminPunchDetails,
  getCompanyAdminAttendanceCalendar,
  getCompanyAdminAttendanceHistory,
  companyAdminMarkEmployeePunch,
};
