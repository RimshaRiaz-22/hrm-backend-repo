const express = require('express');
const shiftsController = require('../controllers/shifts.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('shifts', 'add'), shiftsController.createShift);
router.get('/', ...protect('shifts', 'view'), shiftsController.getShifts);
router.get('/:id', ...protect('shifts', 'view'), shiftsController.getShiftById);
router.patch('/:id', ...protect('shifts', 'edit'), shiftsController.updateShift);
router.delete('/:id', ...protect('shifts', 'delete'), shiftsController.deleteShift);

module.exports = router;
