const express = require('express');
const payslipController = require('../controllers/payslip.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.get('/preview', ...protect('payslips', 'view'), payslipController.previewPayslipPdf);
router.get('/preview/email', ...protect('payslips', 'view'), payslipController.previewPayslipEmail);
router.post('/preview/send', ...protect('payslips', 'add'), payslipController.previewSendPayslipEmail);

module.exports = router;
