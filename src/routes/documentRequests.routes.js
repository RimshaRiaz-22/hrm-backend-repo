const express = require('express');
const documentRequestController = require('../controllers/documentRequest.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('documents', 'add'), documentRequestController.createDocumentRequest);
router.get('/my', ...protect('documents', 'view'), documentRequestController.getMyDocumentRequests);
router.get('/team', ...protect('documents', 'view'), documentRequestController.getTeamDocumentRequests);
router.get('/team/:id', ...protect('documents', 'view'), documentRequestController.getTeamDocumentRequestById);
router.patch(
  '/team/:id/status',
  ...protect('documents', 'edit'),
  documentRequestController.updateTeamDocumentRequestStatus
);
router.get('/', ...protect('documents', 'view'), documentRequestController.getHrDocumentRequests);
router.get('/:id', ...protect('documents', 'view'), documentRequestController.getHrDocumentRequestById);
router.patch('/:id/cancel', ...protect('documents', 'edit'), documentRequestController.cancelDocumentRequest);
router.patch('/:id/upload', ...protect('documents', 'edit'), documentRequestController.uploadFinalDocument);
router.patch('/:id/reject', ...protect('documents', 'edit'), documentRequestController.rejectDocumentRequest);

module.exports = router;
