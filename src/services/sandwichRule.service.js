/**
 * Sandwich rule — unpaid absence on both sides of weekly offs / holidays
 * causes those bridge days to count as unpaid absences for payroll.
 */

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function addOneUtcDateKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(
    next.getUTCDate()
  ).padStart(2, '0')}`;
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

function daysInMonth(periodMonth) {
  const [year, month] = String(periodMonth).split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Resolve payroll period date keys from schedule start_day/end_day within period_month.
 * Monthly schedules require end_day >= start_day (validated at schedule create).
 */
function periodDateKeysFromSchedule(periodMonth, schedule) {
  const monthDays = daysInMonth(periodMonth);
  const startDay = Math.min(Math.max(1, Number(schedule?.start_day) || 1), monthDays);
  const endDay = Math.min(Math.max(startDay, Number(schedule?.end_day) || monthDays), monthDays);
  const startKey = `${periodMonth}-${String(startDay).padStart(2, '0')}`;
  const endKey = `${periodMonth}-${String(endDay).padStart(2, '0')}`;
  return eachUtcDateKeyInRange(startKey, endKey);
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
 * Classify one calendar day for sandwich evaluation.
 *
 * kind:
 * - unpaid_absent — unpaid leave or punch-absent on a scheduled working day
 * - bridge — weekly off or holiday (may become sandwich absence)
 * - other — present / late / paid leave / future (breaks sandwich flanks)
 */
function classifyPayrollDay({
  dateKey,
  workingDays = [],
  isHoliday = false,
  leavePaidStatus = null,
  attendanceStatus = 'absent',
  todayKey = null,
}) {
  const scheduledWorkingDays = normalizeWorkingDays(workingDays);
  const weekday = getWeekdayName(dateKey);
  const isWorkingDay =
    scheduledWorkingDays.length === 0 || scheduledWorkingDays.includes(weekday);
  const isScheduledWorkingDay = isWorkingDay && !isHoliday;
  const isFuture = Boolean(todayKey && dateKey > todayKey);

  if (isFuture) {
    return {
      date: dateKey,
      kind: 'other',
      status: 'future',
      is_scheduled_working_day: isScheduledWorkingDay,
    };
  }

  if (leavePaidStatus === 'unpaid') {
    // Unpaid leave on weekly offs / holidays stays a bridge day so sandwich
    // expansion can count it when both flanks are unpaid absences.
    if (!isScheduledWorkingDay) {
      return {
        date: dateKey,
        kind: 'bridge',
        status: isHoliday ? 'holiday' : 'off_day',
        is_scheduled_working_day: false,
      };
    }
    return {
      date: dateKey,
      kind: 'unpaid_absent',
      status: 'unpaid_leave',
      is_scheduled_working_day: true,
    };
  }

  if (leavePaidStatus === 'paid') {
    return {
      date: dateKey,
      kind: 'other',
      status: 'paid_leave',
      is_scheduled_working_day: isScheduledWorkingDay,
    };
  }

  if (isHoliday || !isWorkingDay) {
    return {
      date: dateKey,
      kind: 'bridge',
      status: isHoliday ? 'holiday' : 'off_day',
      is_scheduled_working_day: false,
    };
  }

  if (attendanceStatus === 'present' || attendanceStatus === 'late') {
    return {
      date: dateKey,
      kind: 'other',
      status: attendanceStatus,
      is_scheduled_working_day: true,
    };
  }

  return {
    date: dateKey,
    kind: 'unpaid_absent',
    status: 'absent',
    is_scheduled_working_day: true,
  };
}

/**
 * Mark contiguous bridge days flanked by unpaid absences as sandwich absences.
 * @param {Array<{ date: string, kind: string }>} dayKinds chronologically ordered
 * @returns {Set<string>} date keys counted as sandwich absences
 */
function applySandwichRule(dayKinds) {
  const sandwichDates = new Set();
  if (!Array.isArray(dayKinds) || dayKinds.length === 0) return sandwichDates;

  let i = 0;
  while (i < dayKinds.length) {
    if (dayKinds[i].kind !== 'bridge') {
      i += 1;
      continue;
    }

    const start = i;
    while (i < dayKinds.length && dayKinds[i].kind === 'bridge') {
      i += 1;
    }
    const end = i - 1;
    const left = start > 0 ? dayKinds[start - 1] : null;
    const right = end + 1 < dayKinds.length ? dayKinds[end + 1] : null;

    if (left?.kind === 'unpaid_absent' && right?.kind === 'unpaid_absent') {
      for (let j = start; j <= end; j += 1) {
        sandwichDates.add(dayKinds[j].date);
      }
    }
  }

  return sandwichDates;
}

function summarizePayrollAttendance({ classifications = [], sandwichRuleEnabled = false } = {}) {
  const sandwichDates = sandwichRuleEnabled ? applySandwichRule(classifications) : new Set();

  let scheduledWorkingDays = 0;
  let presentDays = 0;
  let unpaidWorkingAbsences = 0;

  for (const day of classifications) {
    if (!day.is_scheduled_working_day) continue;

    // The full period's working-day count is fixed regardless of how much of the
    // period has elapsed — it's the payroll daily-rate divisor, so future days
    // still count here. Only present/absent tallying is limited to days that
    // have actually happened (future attendance can't be known yet).
    scheduledWorkingDays += 1;
    if (day.status === 'future') continue;

    if (day.status === 'present' || day.status === 'late' || day.status === 'paid_leave') {
      presentDays += 1;
    } else if (day.kind === 'unpaid_absent') {
      unpaidWorkingAbsences += 1;
    }
  }

  const sandwichAbsentDays = sandwichDates.size;
  const absentDays = unpaidWorkingAbsences + sandwichAbsentDays;

  return {
    scheduled_working_days: scheduledWorkingDays,
    present_days: presentDays,
    unpaid_working_absences: unpaidWorkingAbsences,
    sandwich_absent_days: sandwichAbsentDays,
    absent_days: absentDays,
    sandwich_dates: [...sandwichDates].sort(),
    calendar_days: classifications.length,
  };
}

function resolveDailyRateDivisor(salaryMethod, summary) {
  const method = String(salaryMethod || 'working_days').trim().toLowerCase();
  if (method === 'calendar_days') {
    return Math.max(1, Number(summary.calendar_days) || 1);
  }
  // working_days and fixed_days use scheduled working days in the period
  return Math.max(1, Number(summary.scheduled_working_days) || 1);
}

function computeAbsenceDeductionAmount(basicSalary, absentDays, salaryMethod, summary) {
  const absences = Number(absentDays) || 0;
  if (absences <= 0) return 0;
  const basic = Number(basicSalary) || 0;
  if (basic <= 0) return 0;
  const divisor = resolveDailyRateDivisor(salaryMethod, summary);
  const amount = (basic / divisor) * absences;
  return Math.min(basic, Math.round(amount * 100) / 100);
}

module.exports = {
  eachUtcDateKeyInRange,
  periodDateKeysFromSchedule,
  normalizeWorkingDays,
  getWeekdayName,
  classifyPayrollDay,
  applySandwichRule,
  summarizePayrollAttendance,
  resolveDailyRateDivisor,
  computeAbsenceDeductionAmount,
};
