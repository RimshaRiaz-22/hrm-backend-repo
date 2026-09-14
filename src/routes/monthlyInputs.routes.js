const express = require('express');
const monthlyInputsController = require('../controllers/monthlyInputs.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();
const mod = 'monthly_inputs';

router.post('/', ...protect(mod, 'add'), monthlyInputsController.create);
router.post('/import', ...protect(mod, 'add'), monthlyInputsController.importRows);
router.get('/', ...protect(mod, 'view'), monthlyInputsController.list);
router.patch('/transition', ...protect(mod, 'edit'), monthlyInputsController.transition);
router.delete('/', ...protect(mod, 'delete'), monthlyInputsController.remove);
router.get('/:id', ...protect(mod, 'view'), monthlyInputsController.getOne);
router.patch('/:id', ...protect(mod, 'edit'), monthlyInputsController.update);

module.exports = router;
