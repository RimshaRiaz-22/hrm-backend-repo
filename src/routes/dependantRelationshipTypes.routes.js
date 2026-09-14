const express = require('express');
const dependantRelationshipTypesController = require('../controllers/dependantRelationshipTypes.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post(
  '/',
  ...protect('dependant_relationship_types', 'add'),
  dependantRelationshipTypesController.createDependantRelationshipType
);
router.get(
  '/',
  ...protect('dependant_relationship_types', 'view'),
  dependantRelationshipTypesController.getDependantRelationshipTypes
);
router.get(
  '/:id',
  ...protect('dependant_relationship_types', 'view'),
  dependantRelationshipTypesController.getDependantRelationshipTypeById
);
router.patch(
  '/:id',
  ...protect('dependant_relationship_types', 'edit'),
  dependantRelationshipTypesController.updateDependantRelationshipType
);
router.delete(
  '/:id',
  ...protect('dependant_relationship_types', 'delete'),
  dependantRelationshipTypesController.deleteDependantRelationshipType
);

module.exports = router;
