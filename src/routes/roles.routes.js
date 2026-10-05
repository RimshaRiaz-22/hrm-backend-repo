const express = require('express');
const rolesController = require('../controllers/roles.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('job_roles', 'add'), rolesController.createRole);
router.get('/', ...protect('job_roles', 'view'), rolesController.getRoles);
router.get('/:id', ...protect('job_roles', 'view'), rolesController.getRoleById);
router.patch('/:id', ...protect('job_roles', 'edit'), rolesController.updateRole);
router.delete('/:id', ...protect('job_roles', 'delete'), rolesController.deleteRole);

module.exports = router;
