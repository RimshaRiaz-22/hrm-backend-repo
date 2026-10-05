const express = require('express');
const workLocationsController = require('../controllers/workLocations.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('work_locations', 'add'), workLocationsController.createWorkLocation);
router.get('/', ...protect('work_locations', 'view'), workLocationsController.getWorkLocations);
router.get('/:id', ...protect('work_locations', 'view'), workLocationsController.getWorkLocationById);
router.patch('/:id', ...protect('work_locations', 'edit'), workLocationsController.updateWorkLocation);
router.delete('/:id', ...protect('work_locations', 'delete'), workLocationsController.deleteWorkLocation);

module.exports = router;
