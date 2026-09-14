const express = require('express');
const taxCertificateController = require('../controllers/taxCertificate.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get('/', ...protect('tax_certificates', 'view'), taxCertificateController.list);
router.post('/', ...protect('tax_certificates', 'add'), taxCertificateController.generateAndSend);

module.exports = router;
