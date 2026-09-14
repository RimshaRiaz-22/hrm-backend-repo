const express = require('express');
const designationsController = require('../controllers/designations.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('designations', 'add'), designationsController.createDesignation);
router.get('/', ...protect('designations', 'view'), designationsController.getDesignations);
router.get('/:id', ...protect('designations', 'view'), designationsController.getDesignationById);
router.patch('/:id', ...protect('designations', 'edit'), designationsController.updateDesignation);
router.delete('/:id', ...protect('designations', 'delete'), designationsController.deleteDesignation);

module.exports = router;
