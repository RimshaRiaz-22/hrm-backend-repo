const express = require('express');
const companiesController = require('../controllers/companies.controller');
const { protect } = require('../middleware/routeProtection');
const { validateCurrencyFields } = require('../middleware/validateCurrencyFields');

const router = express.Router();

const requiredCompanyCurrency = validateCurrencyFields([
  {
    paths: ['currency'],
    required: true,
    writePaths: ['currency'],
  },
]);

const optionalCompanyCurrency = validateCurrencyFields([
  {
    paths: ['currency'],
    required: false,
    writePaths: ['currency'],
  },
]);

router.get('/', ...protect('companies', 'view'), companiesController.getCompanies);
router.post(
  '/',
  ...protect('companies', 'add'),
  requiredCompanyCurrency,
  companiesController.createCompany
);
router.patch(
  '/:id',
  ...protect('companies', 'edit'),
  optionalCompanyCurrency,
  companiesController.updateCompany
);
router.delete('/:id', ...protect('companies', 'delete'), companiesController.deleteCompany);

module.exports = router;
