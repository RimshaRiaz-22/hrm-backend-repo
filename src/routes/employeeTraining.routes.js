const express = require('express');
const employeeTrainingController = require('../controllers/employeeTraining.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get('/', ...protect('employee_training', 'view'), employeeTrainingController.listMyTrainingMaterials);
router.post(
  '/:trainingMaterialId/complete',
  ...protect('employee_training', 'add'),
  employeeTrainingController.completeMyTrainingItem
);
router.post('/complete', ...protect('employee_training', 'add'), employeeTrainingController.completeMyTraining);

module.exports = router;
