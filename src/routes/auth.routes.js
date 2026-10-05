const express = require('express');
const authController = require('../controllers/auth.controller');
const companiesController = require('../controllers/companies.controller');
const { requireAuth, requireSuperAdmin, requireCompanyAdmin } = require('../middleware/auth.middleware');
const { validatePhoneFields } = require('../middleware/validatePhoneFields');
const { validateCurrencyFields } = require('../middleware/validateCurrencyFields');

const router = express.Router();

const requiredUserPhone = validatePhoneFields([
  {
    paths: ['phone_number'],
    required: true,
    fieldName: 'phone number',
    writePaths: ['phone_number'],
  },
]);

const optionalUserPhone = validatePhoneFields([
  {
    paths: ['phone_number'],
    required: false,
    fieldName: 'phone number',
    writePaths: ['phone_number'],
  },
]);

const requiredBusinessPhone = validatePhoneFields([
  {
    paths: ['business_phone_no'],
    required: true,
    fieldName: 'business phone',
    writePaths: ['business_phone_no'],
  },
]);

const requiredCompanyCurrency = validateCurrencyFields([
  {
    paths: ['currency'],
    required: true,
    writePaths: ['currency'],
  },
]);

router.post('/super-admin/register', authController.registerSuperAdmin);
router.post('/company-admin/register', authController.registerCompanyAdmin);
router.post('/employee/register', requiredUserPhone, authController.registerEmployee);
router.post(
  '/super-admin/company-admins',
  requireAuth,
  requireSuperAdmin,
  authController.createCompanyAdminInvite
);
router.post('/company-admin/verify-account', authController.verifyCompanyAdminAccount);
router.post('/company-admin/create-profile', requiredUserPhone, authController.createCompanyAdminProfile);
router.post(
  '/company-admin/create-company',
  requiredBusinessPhone,
  requiredCompanyCurrency,
  authController.createCompanyWithSetupToken
);
router.post('/company-admin/employees', requireAuth, requireCompanyAdmin, authController.createEmployeeInvite);

router.post('/employee/verify-otp', authController.verifyOtp);
router.post('/employee/resend-invite', authController.resendEmployeeInvite);
router.post('/employee/resend-password-link', authController.resendEmployeePasswordSetLink);
router.post('/employee/set-password', authController.setEmployeePassword);
router.post('/employee/create-profile', requiredUserPhone, authController.createEmployeeProfile);
router.get('/companies', companiesController.getPublicCompanies);

router.post('/verify-otp', authController.verifyOtp);
router.post('/resend-otp', authController.resendOtp);
router.post('/verify-reset-code', authController.verifyResetCode);
router.post('/resend-reset-code', authController.resendResetCode);

router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.post('/change-password', requireAuth, authController.changePassword);

router.post('/login', authController.login);
router.get('/profile', authController.getProfile);
router.get('/me', authController.getProfile);
router.patch('/profile', optionalUserPhone, authController.updateProfile);
router.patch(
  '/company-admin/profile',
  requireAuth,
  requireCompanyAdmin,
  optionalUserPhone,
  authController.updateCompanyAdminProfile
);
router.patch('/employee/profile', requireAuth, optionalUserPhone, authController.updateEmployeeProfile);

module.exports = router;
