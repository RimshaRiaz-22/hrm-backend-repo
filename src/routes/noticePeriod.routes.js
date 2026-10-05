const express = require('express');
const noticePeriodController = require('../controllers/noticePeriod.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get('/', ...protect('notice_periods', 'view'), noticePeriodController.listNoticePeriods);
router.get('/alerts', ...protect('notice_periods', 'view'), noticePeriodController.listHrExitAlerts);
router.patch('/:id/waive', ...protect('notice_periods', 'edit'), noticePeriodController.waiveNoticePeriod);

module.exports = router;
