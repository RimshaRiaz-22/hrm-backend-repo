const express = require('express');
const attendanceController = require('../controllers/attendance.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get('/modes', attendanceController.getAttendanceModes);
router.post('/employee/punch', ...protect('attendance', 'add'), attendanceController.punchMyAttendance);
router.get(
  '/employee/punch/last-activity',
  ...protect('attendance', 'view'),
  attendanceController.getEmployeeLastPunchActivity
);
router.get(
  '/employee/punch/details',
  ...protect('attendance', 'view'),
  attendanceController.getMyPunchDetails
);
router.get('/employee/calendar', ...protect('attendance', 'view'), attendanceController.getAttendanceCalendar);

router.get('/my/today-status', ...protect('attendance', 'view'), attendanceController.getMyTodayAttendanceStatus);
router.post('/my/mark', ...protect('attendance', 'add'), attendanceController.markMyAttendance);
router.post('/my/clock-in', ...protect('attendance', 'add'), attendanceController.clockInMyAttendance);
router.post('/my/break-in', ...protect('attendance', 'add'), attendanceController.breakInMyAttendance);
router.post('/my/break-out', ...protect('attendance', 'add'), attendanceController.breakOutMyAttendance);
router.post('/my/clock-out', ...protect('attendance', 'add'), attendanceController.clockOutMyAttendance);
router.post(
  '/Company-admin/punch',
  ...protect('attendance', 'edit'),
  attendanceController.companyAdminMarkEmployeePunch
);
router.post(
  '/company-admin/punch',
  ...protect('attendance', 'edit'),
  attendanceController.companyAdminMarkEmployeePunch
);
router.post('/admin/punch', ...protect('attendance', 'edit'), attendanceController.adminMarkAttendancePunch);
router.get(
  '/admin/details/:employee_id',
  ...protect('attendance', 'view'),
  attendanceController.adminGetAttendanceDetails
);
router.get(
  '/company-admin/today-logs',
  ...protect('attendance', 'view'),
  attendanceController.getCompanyAdminTodayLogs
);
router.get(
  '/company-admin/punches/:punch_id',
  ...protect('attendance', 'view'),
  attendanceController.getCompanyAdminPunchDetails
);
router.get(
  '/company-admin/calendar',
  ...protect('attendance', 'view'),
  attendanceController.getCompanyAdminAttendanceCalendar
);
router.get(
  '/company-admin/history',
  ...protect('attendance', 'view'),
  attendanceController.getCompanyAdminAttendanceHistory
);
router.get('/calendar', ...protect('attendance', 'view'), attendanceController.getAttendanceCalendar);
router.post('/mark', ...protect('attendance', 'add'), attendanceController.markAttendance);
router.post(
  '/settings',
  ...protect('attendance', 'edit'),
  attendanceController.upsertAttendanceLocationSettings
);
router.get('/settings', ...protect('attendance', 'view'), attendanceController.getAttendanceLocationSettings);
router.get('/', ...protect('attendance', 'view'), attendanceController.getAttendances);
router.get('/:id', ...protect('attendance', 'view'), attendanceController.getAttendanceById);
router.post('/:id/approve', ...protect('attendance', 'edit'), attendanceController.approveAttendance);
router.post('/:id/reject', ...protect('attendance', 'edit'), attendanceController.rejectAttendance);

module.exports = router;
