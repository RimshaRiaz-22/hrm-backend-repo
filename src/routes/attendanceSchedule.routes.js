const express = require('express');
const attendanceScheduleController = require('../controllers/attendanceSchedule.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('attendance_schedules', 'add'), attendanceScheduleController.createAttendanceSchedule);
router.get('/', ...protect('attendance_schedules', 'view'), attendanceScheduleController.getAttendanceSchedules);
router.get(
  '/:id',
  ...protect('attendance_schedules', 'view'),
  attendanceScheduleController.getAttendanceScheduleById
);
router.patch(
  '/:id',
  ...protect('attendance_schedules', 'edit'),
  attendanceScheduleController.updateAttendanceSchedule
);
router.delete(
  '/:id',
  ...protect('attendance_schedules', 'delete'),
  attendanceScheduleController.deleteAttendanceSchedule
);

module.exports = router;
