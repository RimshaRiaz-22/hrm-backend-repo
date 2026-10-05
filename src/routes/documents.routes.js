const express = require('express');
const documentsController = require('../controllers/documents.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get('/management', ...protect('documents', 'view'), documentsController.getDocumentManagement);
router.post('/request/bulk', ...protect('documents', 'add'), documentsController.createBulkDocumentRequests);
router.post('/company-upload', ...protect('documents', 'add'), documentsController.createCompanyUpload);
router.post('/request', ...protect('documents', 'add'), documentsController.createDocumentRequest);
router.get('/required', ...protect('documents', 'view'), documentsController.getRequiredDocuments);
router.get('/company-list', ...protect('documents', 'view'), documentsController.listCompanyUploadedDocuments);
router.get('/company', ...protect('documents', 'view'), documentsController.getCompanyDocuments);
router.patch('/:id/upload', ...protect('documents', 'edit'), documentsController.uploadDocument);
router.patch('/:id/update-request', ...protect('documents', 'edit'), documentsController.updateDocumentRequest);
router.patch('/:id/cancel', ...protect('documents', 'edit'), documentsController.cancelDocumentRequest);
router.patch('/:id/approve', ...protect('documents', 'edit'), documentsController.approveDocument);
router.patch('/:id/reject', ...protect('documents', 'edit'), documentsController.rejectDocument);
router.get('/:id', ...protect('documents', 'view'), documentsController.getDocumentById);

module.exports = router;
