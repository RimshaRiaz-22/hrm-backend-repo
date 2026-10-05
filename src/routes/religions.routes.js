const express = require('express');
const religionsController = require('../controllers/religions.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('religions', 'add'), religionsController.createReligion);
router.get('/', ...protect('religions', 'view'), religionsController.getReligions);
router.get('/:id', ...protect('religions', 'view'), religionsController.getReligionById);
router.patch('/:id', ...protect('religions', 'edit'), religionsController.updateReligion);
router.delete('/:id', ...protect('religions', 'delete'), religionsController.deleteReligion);

module.exports = router;
