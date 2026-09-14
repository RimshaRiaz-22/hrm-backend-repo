const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { sendSuccess, sendError } = require('../utils/apiResponse');

const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeName = (path.basename(file.originalname || 'image', ext) || 'image')
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .toLowerCase();
    cb(null, `${Date.now()}-${safeName}${ext}`);
  },
});

const allowedMimeTypes = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/rtf',
  'application/zip',
]);

function isAllowedUpload(file) {
  if (!file.mimetype) {
    return false;
  }
  if (file.mimetype.startsWith('image/')) {
    return true;
  }
  return allowedMimeTypes.has(file.mimetype);
}

const imageUpload = multer({
  storage,
  limits: {
    // Images + PDFs (scanned docs can be larger than typical photos)
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (!isAllowedUpload(file)) {
      return cb(
        new Error('Only images or document files (PDF, Word, Excel, PowerPoint, text, CSV, ZIP) are allowed.')
      );
    }
    return cb(null, true);
  },
});

function buildFileUrl(req, filename) {
  return `${req.protocol}://${req.get('host')}/uploads/${filename}`;
}

function uploadImage(req, res) {
  if (!req.file) {
    return sendError(res, 400, 'Please upload an image or PDF file in the "image" field.');
  }

  const imageUrl = buildFileUrl(req, req.file.filename);
  return sendSuccess(res, 201, 'File uploaded successfully.', {
    image_url: imageUrl,
    file_url: imageUrl,
    filename: req.file.filename,
    original_name: req.file.originalname || null,
    mime_type: req.file.mimetype,
  });
}

function handleUploadError(err, req, res, next) {
  if (!err) {
    return next();
  }

  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return sendError(res, 400, 'File size must be 10MB or less.');
  }

  return sendError(res, 400, err.message || 'File upload failed.');
}

// Separate, higher-limit config for training content (videos can be much larger than the
// 10MB image/PDF cap above) — kept as its own multer instance so it doesn't loosen the
// size/type constraints every other upload caller relies on.
const trainingMimeTypes = new Set([
  'application/pdf',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
]);

function isAllowedTrainingUpload(file) {
  return Boolean(file.mimetype) && trainingMimeTypes.has(file.mimetype);
}

const trainingUpload = multer({
  storage,
  limits: {
    fileSize: 300 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (!isAllowedTrainingUpload(file)) {
      return cb(new Error('Only PDF or video files (mp4, webm, mov, avi) are allowed.'));
    }
    return cb(null, true);
  },
});

function uploadTrainingFile(req, res) {
  if (!req.file) {
    return sendError(res, 400, 'Please upload a PDF or video file in the "file" field.');
  }

  const fileUrl = buildFileUrl(req, req.file.filename);
  return sendSuccess(res, 201, 'File uploaded successfully.', {
    file_url: fileUrl,
    filename: req.file.filename,
    original_name: req.file.originalname || null,
    mime_type: req.file.mimetype,
  });
}

function handleTrainingUploadError(err, req, res, next) {
  if (!err) {
    return next();
  }

  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return sendError(res, 400, 'File size must be 300MB or less.');
  }

  return sendError(res, 400, err.message || 'File upload failed.');
}

module.exports = {
  imageUpload,
  uploadImage,
  handleUploadError,
  trainingUpload,
  uploadTrainingFile,
  handleTrainingUploadError,
};
