const express = require('express');
const notesController = require('../controllers/notes.controller');
const { protect } = require('../middleware/routeProtection');

const router = express.Router();

router.post('/', ...protect('notes', 'add'), notesController.createNote);
router.get('/', ...protect('notes', 'view'), notesController.getNotes);
router.patch('/:id', ...protect('notes', 'edit'), notesController.updateNote);
router.delete('/:id', ...protect('notes', 'delete'), notesController.deleteNote);

module.exports = router;
