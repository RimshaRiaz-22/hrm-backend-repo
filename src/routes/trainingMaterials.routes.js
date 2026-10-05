const express = require('express');
const trainingMaterialsController = require('../controllers/trainingMaterials.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('training', 'add'), trainingMaterialsController.createTrainingMaterial);
router.get('/', ...protect('training', 'view'), trainingMaterialsController.getTrainingMaterials);
router.get('/:id', ...protect('training', 'view'), trainingMaterialsController.getTrainingMaterialById);
router.patch('/:id', ...protect('training', 'edit'), trainingMaterialsController.updateTrainingMaterial);
router.delete('/:id', ...protect('training', 'delete'), trainingMaterialsController.deleteTrainingMaterial);

module.exports = router;
