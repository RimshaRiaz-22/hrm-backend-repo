const express = require('express');
const dependantsController = require('../controllers/dependants.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get(
  '/relationship-options',
  ...protect('dependants', 'view'),
  dependantsController.getRelationshipOptions
);
router.post('/', ...protect('dependants', 'add'), dependantsController.createDependant);
router.get('/', ...protect('dependants', 'view'), dependantsController.getDependants);
router.get('/:id', ...protect('dependants', 'view'), dependantsController.getDependantById);
router.patch('/:id', ...protect('dependants', 'edit'), dependantsController.updateDependant);
router.delete('/:id', ...protect('dependants', 'delete'), dependantsController.deleteDependant);

module.exports = router;
