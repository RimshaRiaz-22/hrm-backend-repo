const {
  deriveClockInStatus,
  getEmployeeAttendanceProfile,
  getPunchesForDate,
  insertCorrectionPunch,
} = require('./attendancePunch.service');
const { toUtcDate } = require('../utils/dateTime');

/**
 * Applies an attendance correction. Only provided corrected times are changed;
 * the other punch types on that day are preserved (breaks included).
 */
async function applyAttendanceCorrection(client, {
  employeeId,
  correctionDate,
  correctedCheckIn,
  correctedCheckOut,
  reviewedBy,
  requestId,
}) {
  const employee = await getEmployeeAttendanceProfile(client, employeeId);
  if (!employee) {
    throw new Error('Employee not found.');
  }

  const checkInDate = toUtcDate(correctedCheckIn);
  const checkOutDate = toUtcDate(correctedCheckOut);

  if (!checkInDate && !checkOutDate) {
    throw new Error('No corrected check-in or check-out time to apply.');
  }

  if (checkInDate && checkOutDate && checkOutDate.getTime() <= checkInDate.getTime()) {
    throw new Error('Corrected check-out must be after corrected check-in.');
  }

  if (checkInDate && checkOutDate) {
    await client.query(
      `DELETE FROM attendance_punches
       WHERE employee_id = $1 AND attendance_date = $2`,
      [employeeId, correctionDate]
    );

    const clockInStatus = deriveClockInStatus(employee, correctionDate, checkInDate);
    await insertCorrectionPunch(client, {
      employeeId,
      attendanceDate: correctionDate,
      actionType: 'clock_in',
      punchedAt: checkInDate,
      markedBy: reviewedBy,
      requestId,
      attendanceStatus: clockInStatus,
    });
    await insertCorrectionPunch(client, {
      employeeId,
      attendanceDate: correctionDate,
      actionType: 'clock_out',
      punchedAt: checkOutDate,
      markedBy: reviewedBy,
      requestId,
      attendanceStatus: 'recorded',
    });
    return;
  }

  if (checkInDate) {
    await client.query(
      `DELETE FROM attendance_punches
       WHERE employee_id = $1
         AND attendance_date = $2
         AND action_type = 'clock_in'`,
      [employeeId, correctionDate]
    );

    const clockInStatus = deriveClockInStatus(employee, correctionDate, checkInDate);
    await insertCorrectionPunch(client, {
      employeeId,
      attendanceDate: correctionDate,
      actionType: 'clock_in',
      punchedAt: checkInDate,
      markedBy: reviewedBy,
      requestId,
      attendanceStatus: clockInStatus,
    });
    return;
  }

  if (checkOutDate) {
    const existingPunches = await getPunchesForDate(client, employeeId, correctionDate);
    const clockInPunch = [...existingPunches]
      .reverse()
      .find((p) => p.action_type === 'clock_in');

    if (clockInPunch) {
      const clockInInstant = toUtcDate(clockInPunch.punched_at);
      if (clockInInstant && checkOutDate.getTime() <= clockInInstant.getTime()) {
        throw new Error('Corrected check-out must be after the existing check-in.');
      }
    }

    await client.query(
      `DELETE FROM attendance_punches
       WHERE employee_id = $1
         AND attendance_date = $2
         AND action_type = 'clock_out'`,
      [employeeId, correctionDate]
    );

    await insertCorrectionPunch(client, {
      employeeId,
      attendanceDate: correctionDate,
      actionType: 'clock_out',
      punchedAt: checkOutDate,
      markedBy: reviewedBy,
      requestId,
      attendanceStatus: 'recorded',
    });
  }
}

module.exports = {
  applyAttendanceCorrection,
};
