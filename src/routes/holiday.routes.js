const express = require('express');
const holidayController = require('../controllers/holiday.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get('/calendar', ...protect('holidays', 'view'), holidayController.getHolidayCalendar);

router.post('/types', ...protect('holiday_types', 'add'), holidayController.createHolidayType);
router.get('/types', ...protect('holiday_types', 'view'), holidayController.getHolidayTypes);
router.get('/types/:id', ...protect('holiday_types', 'view'), holidayController.getHolidayTypeById);
router.patch('/types/:id', ...protect('holiday_types', 'edit'), holidayController.updateHolidayType);
router.delete('/types/:id', ...protect('holiday_types', 'delete'), holidayController.deleteHolidayType);

router.post('/', ...protect('holidays', 'add'), holidayController.createHoliday);
router.get('/', ...protect('holidays', 'view'), holidayController.getHolidays);
router.get('/:id', ...protect('holidays', 'view'), holidayController.getHolidayById);
router.patch('/:id', ...protect('holidays', 'edit'), holidayController.updateHoliday);
router.put('/:id', ...protect('holidays', 'edit'), holidayController.replaceHoliday);
router.delete('/:id', ...protect('holidays', 'delete'), holidayController.deleteHoliday);

module.exports = router;
