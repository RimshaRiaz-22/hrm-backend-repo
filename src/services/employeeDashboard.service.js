const pool = require('../db');
const { toDateKey, parseOptionalDateInput } = require('../utils/dateTime');
const holidayService = require('./holiday.service');
const {
  deriveDayAttendanceStatus,
  getEmployeeAttendanceProfile,
  getPunchesForDate,
} = require('./attendancePunch.service');

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const REQUEST_ITEM_LABELS = {
  attendance_correction: 'Attendance Correction',
  wfh: 'WFH Request',
  loan: 'Loan Request',
  pf_temporary: 'PF Temporary Request',
  pf_permanent: 'PF Permanent Request',
  advance: 'Advance Request',
  expense: 'Expense Request',
  resignation: 'Resignation',
  document: 'Document Request',
};

const PENDING_REQUEST_COUNT_ORDER = [
  'attendance_correction',
  'wfh',
  'loan',
  'pf_temporary',
  'pf_permanent',
  'advance',
  'expense',
  'resignation',
  'document',
];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function parseDashboardDate(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: getTodayDateString() };
  }
  const parsed = parseOptionalDateInput(raw, 'date');
  if (parsed.error) return { error: [400, parsed.error] };
  return { value: parsed.value };
}

function buildSummaryCard(label, value) {
  return { label, value };
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

function sortPunchTimeline(punches = []) {
  return [...punches].sort((a, b) => {
    const aTime = new Date(a.punched_at).getTime();
    const bTime = new Date(b.punched_at).getTime();
    if (aTime !== bTime) return aTime - bTime;
    return Number(a.id || 0) - Number(b.id || 0);
  });
}

function replayPunchSession(punches = []) {
  let activeClockIn = null;
  let activeBreak = null;
  let completedSessionCount = 0;
  let completedBreakCount = 0;

  for (const punch of sortPunchTimeline(punches)) {
    const action = normalizePunchAction(punch.action_type);
    if (action === 'clock_in') {
      activeClockIn = punch;
      activeBreak = null;
    } else if (action === 'break_start' && activeClockIn && !activeBreak) {
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

function buildEmployeePunchState(punches = []) {
  const { activeClockIn, activeBreak } = replayPunchSession(punches);
  const timeline = sortPunchTimeline(punches);
  const lastPunch = timeline.length ? timeline[timeline.length - 1] : null;
  const lastAction = lastPunch ? normalizePunchAction(lastPunch.action_type) : null;

  const canBreakStart = Boolean(activeClockIn) && !activeBreak;
  const canBreakEnd = Boolean(activeBreak);
  const canClockOut = Boolean(activeClockIn) && !activeBreak;
  const canClockIn = !activeClockIn && !activeBreak;

  return {
    has_active_clock_in: Boolean(activeClockIn),
    has_active_break: Boolean(activeBreak),
    can_clock_in: canClockIn,
    can_break_start: canBreakStart,
    can_break_end: canBreakEnd,
    can_clock_out: canClockOut,
    last_action: lastAction,
    active_clock_in: activeClockIn,
    latest_clock_out: findLatestClockOut(punches),
  };
}

function findLatestClockIn(punches = []) {
  const timeline = sortPunchTimeline(punches);
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (normalizePunchAction(timeline[index].action_type) === 'clock_in') {
      return timeline[index];
    }
  }
  return null;
}

function findLatestClockOut(punches = []) {
  const timeline = sortPunchTimeline(punches);
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (normalizePunchAction(timeline[index].action_type) === 'clock_out') {
      return timeline[index];
    }
  }
  return null;
}

function formatDisplayTime(value, timeZone = 'UTC') {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not yet';
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timeZone || 'UTC',
  });
}

function mapDayStatusLabel(dayStatus) {
  const status = String(dayStatus || '').toLowerCase();
  if (status === 'present') return 'Present';
  if (status === 'late') return 'Late';
  if (status === 'absent') return 'Absent';
  if (status === 'off_day') return 'Off Day';
  if (status === 'holiday') return 'Holiday';
  return 'Not checked in';
}

const NEXT_ACTION_OPTIONS = {
  clock_in: { label: 'Clock in', value: 'clock_in' },
  break_start: { label: 'Start break', value: 'break_start' },
  break_end: { label: 'End break', value: 'break_end' },
  clock_out: { label: 'Clock out', value: 'clock_out' },
};

function buildNextActions(punchState) {
  const actions = [];

  if (punchState.can_break_end) {
    actions.push(NEXT_ACTION_OPTIONS.break_end);
  }

  if (punchState.can_break_start) {
    actions.push(NEXT_ACTION_OPTIONS.break_start);
  }

  if (punchState.can_clock_out) {
    actions.push(NEXT_ACTION_OPTIONS.clock_out);
  }

  if (punchState.can_clock_in) {
    actions.push(NEXT_ACTION_OPTIONS.clock_in);
  }

  return actions;
}

function formatNextActionsSummary(actions) {
  if (!actions.length) return 'Not Available';
  return actions.map((action) => action.label).join(' / ');
}

function mapStatusLabel(punchState, dayStatus, onLeave) {
  if (onLeave) return 'On Leave';
  if (punchState.has_active_break) return 'On Break';
  if (punchState.has_active_clock_in) return 'Checked In';
  if (punchState.last_action === 'clock_out') return 'Checked Out';
  return mapDayStatusLabel(dayStatus);
}

async function isEmployeeOnLeaveToday(client, employeeId, companyId, attendanceDate) {
  const result = await client.query(
    `SELECT 1
     FROM leave_requests lr
     WHERE lr.employee_id = $1
       AND lr.company_id = $2
       AND lr.status = 'approved'
       AND lr.from_date <= $3::date
       AND lr.to_date >= $3::date
     LIMIT 1`,
    [employeeId, companyId, attendanceDate]
  );
  return result.rowCount > 0;
}

/**
 * GET /api/v1/employee/dashboard/status-today
 */
async function getEmployeeStatusToday(authContext, query = {}) {
  const parsedDate = parseDashboardDate(query.date ?? query.attendance_date);
  if (parsedDate.error) return { error: parsedDate.error };

  const asOfDate = parsedDate.value;
  const employeeId = authContext.employeeId;
  const companyId = authContext.companyId;

  const client = await pool.connect();
  try {
    const [employee, punches, onLeaveToday] = await Promise.all([
      getEmployeeAttendanceProfile(client, employeeId),
      getPunchesForDate(client, employeeId, asOfDate),
      isEmployeeOnLeaveToday(client, employeeId, companyId, asOfDate),
    ]);

    if (!employee) {
      return { error: [404, 'Employee profile not found.'] };
    }

    const timeZone = employee.company_timezone || 'UTC';
    const dayStatus = deriveDayAttendanceStatus(employee, asOfDate, punches);
    const punchState = buildEmployeePunchState(punches);
    const latestClockIn = punchState.active_clock_in || findLatestClockIn(punches);
    const latestClockOut = punchState.latest_clock_out;

    const statusLabel = mapStatusLabel(punchState, dayStatus, onLeaveToday);
    const nextActions = onLeaveToday ? [] : buildNextActions(punchState);
    const nextActionSummary = onLeaveToday ? 'Not Available' : formatNextActionsSummary(nextActions);

    const summary = [
      buildSummaryCard('Status', statusLabel),
      buildSummaryCard('Check In Time', formatDisplayTime(latestClockIn?.punched_at, timeZone)),
      buildSummaryCard('Check Out Time', formatDisplayTime(latestClockOut?.punched_at, timeZone)),
      buildSummaryCard('Next Action', nextActionSummary),
    ];

    return {
      data: {
        as_of_date: asOfDate,
        employee_id: employeeId,
        company_id: companyId,
        summary,
        next_actions: nextActions,
      },
    };
  } finally {
    client.release();
  }
}

function parseDashboardYear(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: new Date().getUTCFullYear() };
  }
  const year = Number(String(raw).trim());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return { error: [400, 'year must be an integer between 2000 and 2100.'] };
  }
  return { value: year };
}

function formatLeaveDays(availableDays) {
  const normalized = Number(availableDays);
  const days = Number.isFinite(normalized) ? normalized : 0;
  const display = Number.isInteger(days) ? String(days) : String(Math.round(days * 100) / 100);
  return `${display} ${days === 1 ? 'day' : 'days'}`;
}

async function fetchPendingLeaveRequestCount(client, companyId, employeeId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM leave_requests
     WHERE company_id = $1
       AND employee_id = $2
       AND status IN ('pending', 'manager_approved')`,
    [companyId, employeeId]
  );
  return Number(result.rows[0]?.total || 0);
}

async function fetchPendingRequestCountsByType(client, companyId, employeeId) {
  const result = await client.query(
    `SELECT r.request_type, COUNT(*)::int AS total
     FROM requests r
     WHERE r.company_id = $1
       AND r.employee_id = $2
       AND r.status IN ('pending', 'manager_approved')
     GROUP BY r.request_type`,
    [companyId, employeeId]
  );

  const counts = {};
  for (const row of result.rows) {
    counts[String(row.request_type || '')] = Number(row.total || 0);
  }
  return counts;
}

function buildPendingRequestCountItems(leaveCount, requestCountsByType) {
  const items = [];

  if (leaveCount > 0) {
    items.push(buildSummaryCard('Leave requests', leaveCount));
  }

  for (const requestType of PENDING_REQUEST_COUNT_ORDER) {
    const count = Number(requestCountsByType[requestType] || 0);
    if (count > 0) {
      items.push(buildSummaryCard(REQUEST_ITEM_LABELS[requestType], count));
    }
  }

  return items;
}

async function fetchEmployeeLeaveBalanceCards(client, companyId, employeeId, year) {
  const result = await client.query(
    `SELECT lb.available_days,
            lp.name AS leave_policy_name
     FROM leave_balances lb
     INNER JOIN leave_policies lp
       ON lp.id = lb.leave_policy_id
      AND lp.company_id = lb.company_id
     WHERE lb.company_id = $1
       AND lb.employee_id = $2
       AND lb.year = $3
     ORDER BY lp.name ASC`,
    [companyId, employeeId, year]
  );

  return result.rows.map((row) =>
    buildSummaryCard(row.leave_policy_name, formatLeaveDays(row.available_days))
  );
}

/**
 * GET /api/v1/employee/dashboard/leave-balances
 */
async function getEmployeeLeaveBalances(authContext, query = {}) {
  const parsedYear = parseDashboardYear(query.year);
  if (parsedYear.error) return { error: parsedYear.error };

  const year = parsedYear.value;
  const employeeId = authContext.employeeId;
  const companyId = authContext.companyId;

  const client = await pool.connect();
  try {
    const cards = await fetchEmployeeLeaveBalanceCards(client, companyId, employeeId, year);

    return {
      data: {
        year,
        employee_id: employeeId,
        company_id: companyId,
        cards,
      },
    };
  } finally {
    client.release();
  }
}

/**
 * GET /api/v1/employee/dashboard/pending-requests
 * Pending request counts grouped by request type (label + count).
 */
async function getEmployeePendingRequests(authContext) {
  const employeeId = authContext.employeeId;
  const companyId = authContext.companyId;

  const client = await pool.connect();
  try {
    const [leaveCount, requestCountsByType] = await Promise.all([
      fetchPendingLeaveRequestCount(client, companyId, employeeId),
      fetchPendingRequestCountsByType(client, companyId, employeeId),
    ]);

    const items = buildPendingRequestCountItems(leaveCount, requestCountsByType);
    const total =
      leaveCount +
      PENDING_REQUEST_COUNT_ORDER.reduce(
        (sum, requestType) => sum + Number(requestCountsByType[requestType] || 0),
        0
      );

    return {
      data: {
        employee_id: employeeId,
        company_id: companyId,
        total,
        items,
      },
    };
  } finally {
    client.release();
  }
}

function parseDashboardMonth(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: getTodayDateString().slice(0, 7) };
  }
  const value = String(raw).trim();
  if (!/^\d{4}-\d{2}$/.test(value)) {
    return { error: [400, 'month must be in YYYY-MM format.'] };
  }
  const monthNumber = Number(value.slice(5, 7));
  if (monthNumber < 1 || monthNumber > 12) {
    return { error: [400, 'month must be in YYYY-MM format.'] };
  }
  return { value };
}

function getMonthDateRange(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    startDate: `${month}-01`,
    endDate: `${month}-${String(lastDay).padStart(2, '0')}`,
    daysInMonth: lastDay,
    year,
    monthNumber,
  };
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

function addOneUtcDateKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function eachUtcDateKeyInRange(startKey, endKey) {
  if (!DATE_REGEX.test(startKey) || !DATE_REGEX.test(endKey) || startKey > endKey) return [];
  const dates = [];
  let cursor = startKey;
  while (true) {
    dates.push(cursor);
    if (cursor === endKey) break;
    cursor = addOneUtcDateKey(cursor);
  }
  return dates;
}

function formatMiniCalendarLabel(dateKey) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  const weekday = WEEKDAY_SHORT[date.getUTCDay()];
  const day = Number(dateKey.slice(8, 10));
  return `${weekday} ${day}`;
}

function formatTotalHours(totalMinutes) {
  const minutes = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h ${remainingMinutes}m`;
}

function computeCompletedWorkMinutes(punches = []) {
  const timeline = sortPunchTimeline(
    punches.map((punch) => ({
      ...punch,
      action_type: normalizePunchAction(punch.action_type),
    }))
  );

  let activeSession = null;
  let activeBreak = null;
  const breaks = [];
  let completedWorkMinutes = 0;

  for (const punch of timeline) {
    const punchedAt = new Date(punch.punched_at);
    const action = normalizePunchAction(punch.action_type);

    if (action === 'clock_in') {
      activeSession = { clock_in_time: punch.punched_at };
      activeBreak = null;
    } else if (action === 'break_start' && activeSession && !activeBreak) {
      activeBreak = { break_start_time: punch.punched_at, break_end_time: null, duration_minutes: 0 };
    } else if (action === 'break_end' && activeBreak) {
      activeBreak.break_end_time = punch.punched_at;
      activeBreak.duration_minutes = Math.max(
        Math.floor((punchedAt.getTime() - new Date(activeBreak.break_start_time).getTime()) / 60000),
        0
      );
      breaks.push(activeBreak);
      activeBreak = null;
    } else if (action === 'clock_out' && activeSession && !activeBreak) {
      const grossMinutes = Math.max(
        Math.floor((punchedAt.getTime() - new Date(activeSession.clock_in_time).getTime()) / 60000),
        0
      );
      const sessionBreakMinutes = breaks
        .filter(
          (item) =>
            item.break_end_time &&
            new Date(item.break_start_time).getTime() >= new Date(activeSession.clock_in_time).getTime() &&
            new Date(item.break_end_time).getTime() <= punchedAt.getTime()
        )
        .reduce((sum, item) => sum + Number(item.duration_minutes || 0), 0);
      completedWorkMinutes += Math.max(grossMinutes - sessionBreakMinutes, 0);
      activeSession = null;
    }
  }

  return completedWorkMinutes;
}

function mapMiniCalendarStatusLabel({ onLeave, isHoliday, isWorkingDay, isFuture, dayStatus }) {
  if (isFuture) return 'Not yet';
  if (onLeave) return 'On Leave';
  if (isHoliday) return 'Holiday';
  if (!isWorkingDay) return 'Off Day';
  if (dayStatus === 'present') return 'Present';
  if (dayStatus === 'late') return 'Late';
  if (dayStatus === 'absent') return 'Absent';
  return mapDayStatusLabel(dayStatus);
}

async function fetchApprovedLeaveDateKeysForRange(client, employeeId, companyId, startDate, endDate) {
  const result = await client.query(
    `SELECT lr.from_date, lr.to_date
     FROM leave_requests lr
     WHERE lr.employee_id = $1
       AND lr.company_id = $2
       AND lr.status = 'approved'
       AND lr.to_date >= $3::date
       AND lr.from_date <= $4::date`,
    [employeeId, companyId, startDate, endDate]
  );

  const leaveDates = new Set();
  for (const row of result.rows) {
    const fromKey = toDateKey(row.from_date);
    const toKey = toDateKey(row.to_date);
    if (!fromKey || !toKey) continue;
    for (const dateKey of eachUtcDateKeyInRange(fromKey, toKey)) {
      if (dateKey >= startDate && dateKey <= endDate) {
        leaveDates.add(dateKey);
      }
    }
  }
  return leaveDates;
}

async function fetchEmployeePunchesForMonth(client, employeeId, startDate, endDate) {
  const result = await client.query(
    `SELECT id, employee_id, attendance_date, action_type, punched_at, source, marked_by,
            work_location_id, latitude, longitude, remarks, attendance_status, created_at
     FROM attendance_punches
     WHERE employee_id = $1
       AND attendance_date >= $2
       AND attendance_date <= $3
     ORDER BY attendance_date ASC, punched_at ASC, id ASC`,
    [employeeId, startDate, endDate]
  );

  const punchesByDate = new Map();
  for (const row of result.rows) {
    const dateKey = toDateKey(row.attendance_date);
    if (!dateKey) continue;
    if (!punchesByDate.has(dateKey)) punchesByDate.set(dateKey, []);
    punchesByDate.get(dateKey).push(row);
  }
  return punchesByDate;
}

function buildEmployeeAttendanceMonthView(employee, month, holidaysByDate, leaveDateKeys, punchesByDate) {
  const { daysInMonth } = getMonthDateRange(month);
  const today = getTodayDateString();
  const scheduledWorkingDays = normalizeWorkingDays(
    employee.working_days || employee.attendance_schedule?.working_days
  );

  const counts = {
    present: 0,
    late: 0,
    absent: 0,
    on_leave: 0,
  };
  let totalWorkMinutes = 0;
  const miniCalendar = [];

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = `${month}-${String(day).padStart(2, '0')}`;
    const weekday = getWeekdayName(dateKey);
    const isWorkingDay = scheduledWorkingDays.length === 0 || scheduledWorkingDays.includes(weekday);
    const isHoliday = (holidaysByDate.get(dateKey) || []).length > 0;
    const onLeave = leaveDateKeys.has(dateKey);
    const isFuture = dateKey > today;
    const punches = punchesByDate.get(dateKey) || [];
    const dayStatus = isHoliday ? 'holiday' : deriveDayAttendanceStatus(employee, dateKey, punches);

    totalWorkMinutes += computeCompletedWorkMinutes(punches);

    if (!isFuture && isWorkingDay && !isHoliday) {
      if (onLeave) {
        counts.on_leave += 1;
      } else if (dayStatus === 'present') {
        counts.present += 1;
      } else if (dayStatus === 'late') {
        counts.late += 1;
      } else if (dayStatus === 'absent') {
        counts.absent += 1;
      }
    }

    miniCalendar.push(
      buildSummaryCard(
        formatMiniCalendarLabel(dateKey),
        mapMiniCalendarStatusLabel({ onLeave, isHoliday, isWorkingDay, isFuture, dayStatus })
      )
    );
  }

  const summary = [
    buildSummaryCard('Present', counts.present),
    buildSummaryCard('Late', counts.late),
    buildSummaryCard('Absent', counts.absent),
    buildSummaryCard('On Leave', counts.on_leave),
    buildSummaryCard('Total Hours', formatTotalHours(totalWorkMinutes)),
  ];

  return { summary, mini_calendar: miniCalendar };
}

/**
 * GET /api/v1/employee/dashboard/attendance-month
 */
async function getEmployeeAttendanceMonth(authContext, query = {}) {
  const parsedMonth = parseDashboardMonth(query.month);
  if (parsedMonth.error) return { error: parsedMonth.error };

  const month = parsedMonth.value;
  const { startDate, endDate } = getMonthDateRange(month);
  const employeeId = authContext.employeeId;
  const companyId = authContext.companyId;

  const client = await pool.connect();
  try {
    const employee = await getEmployeeAttendanceProfile(client, employeeId);
    if (!employee) {
      return { error: [404, 'Employee profile not found.'] };
    }

    const holidayResult = await holidayService.getCompanyHolidaysForMonth(companyId, month);
    if (holidayResult.error) {
      return { error: [400, holidayResult.error] };
    }

    const [leaveDateKeys, punchesByDate] = await Promise.all([
      fetchApprovedLeaveDateKeysForRange(client, employeeId, companyId, startDate, endDate),
      fetchEmployeePunchesForMonth(client, employeeId, startDate, endDate),
    ]);

    const { summary, mini_calendar: miniCalendar } = buildEmployeeAttendanceMonthView(
      employee,
      month,
      holidayResult.holidaysByDate || new Map(),
      leaveDateKeys,
      punchesByDate
    );

    return {
      data: {
        month,
        employee_id: employeeId,
        company_id: companyId,
        summary,
        mini_calendar: miniCalendar,
      },
    };
  } finally {
    client.release();
  }
}

module.exports = {
  getEmployeeStatusToday,
  getEmployeeLeaveBalances,
  getEmployeePendingRequests,
  getEmployeeAttendanceMonth,
};
