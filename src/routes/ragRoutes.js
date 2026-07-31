const express = require('express');
const multer = require('multer');
const authMiddleware = require('../middleware/authMiddleware');
const ragController = require('../controllers/ragController');

const router = express.Router();

// Configure multer to store files in memory as buffers
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed!'), false);
    }
  }
});

// Protect all RAG routes with JWT auth
router.use(authMiddleware);

// Upload a PDF for embedding into user's private namespace
router.post('/upload', upload.single('document'), ragController.uploadDocument);

// Query the RAG system (Hybrid Search + Gemini + Redis cache)
router.post('/query', ragController.queryDocument);

// List all documents in the user's knowledge base
router.get('/documents', ragController.listDocuments);

// Delete a specific document from the user's knowledge base
router.delete('/documents/:filename', ragController.deleteDocument);

module.exports = router;
