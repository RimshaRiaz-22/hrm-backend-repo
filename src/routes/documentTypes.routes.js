const express = require('express');
const documentTypesController = require('../controllers/documentTypes.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('document_types', 'add'), documentTypesController.createDocumentType);
router.get('/', ...protect('document_types', 'view'), documentTypesController.getDocumentTypes);
router.get('/:id', ...protect('document_types', 'view'), documentTypesController.getDocumentTypeById);
router.patch('/:id', ...protect('document_types', 'edit'), documentTypesController.updateDocumentType);
router.delete('/:id', ...protect('document_types', 'delete'), documentTypesController.deleteDocumentType);

module.exports = router;
