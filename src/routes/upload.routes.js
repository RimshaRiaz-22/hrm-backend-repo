const express = require('express');
const {
  imageUpload,
  uploadImage,
  handleUploadError,
  trainingUpload,
  uploadTrainingFile,
  handleTrainingUploadError,
} = require('../controllers/upload.controller');

const router = express.Router();

/** Public upload — no Bearer token required (profiles, employee docs, registration, etc.). */
router.post(
  '/image',
  imageUpload.single('image'),
  uploadImage,
  handleUploadError
);

/** Public upload for training content (PDF/video) — larger size limit than /image. */
router.post(
  '/training-file',
  trainingUpload.single('file'),
  uploadTrainingFile,
  handleTrainingUploadError
);

module.exports = router;
