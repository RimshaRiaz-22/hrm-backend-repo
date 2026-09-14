const express = require('express');
const expenseCategoryController = require('../controllers/expenseCategory.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('expense_categories', 'add'), expenseCategoryController.createExpenseCategory);
router.get('/', ...protect('expense_categories', 'view'), expenseCategoryController.getExpenseCategories);
router.get('/:id', ...protect('expense_categories', 'view'), expenseCategoryController.getExpenseCategoryById);
router.patch('/:id', ...protect('expense_categories', 'edit'), expenseCategoryController.updateExpenseCategory);
router.delete('/:id', ...protect('expense_categories', 'delete'), expenseCategoryController.deleteExpenseCategory);

module.exports = router;
