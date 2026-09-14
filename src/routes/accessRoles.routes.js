const express = require('express');
const accessRolesController = require('../controllers/accessRoles.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get('/system-modules', ...protect('access_roles', 'view'), accessRolesController.listSystemModules);
router.get('/', ...protect('access_roles', 'view'), accessRolesController.listAccessRoles);
router.post('/', ...protect('access_roles', 'add'), accessRolesController.createAccessRole);
router.get('/:id', ...protect('access_roles', 'view'), accessRolesController.getAccessRoleById);
router.patch('/:id', ...protect('access_roles', 'edit'), accessRolesController.updateAccessRole);
router.put('/:id/permissions', ...protect('access_roles', 'edit'), accessRolesController.saveAccessRolePermissions);
router.delete('/:id', ...protect('access_roles', 'delete'), accessRolesController.deleteAccessRole);

module.exports = router;
