// File uploads — profile pictures and chat attachments (images, video,
// documents, GIFs). Files go to Cloudinary; only the resulting URL is
// stored in Postgres.

const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { uploadBuffer, isConfigured } = require('../cloudinary');
const { requireAuth } = require('../utils/authMiddleware');

const router = express.Router();
router.use(requireAuth);

// Keep files in memory briefly, then stream straight to Cloudinary —
// never touches disk. 25MB cap keeps free-tier bandwidth reasonable.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function guessAttachmentType(mimetype) {
  if (mimetype === 'image/gif') return 'gif';
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  return 'file';
}

// POST /uploads/avatar — set your own profile picture
router.post('/avatar', upload.single('file'), async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'File uploads are not configured on this server yet' });
  }
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  if (!req.file.mimetype.startsWith('image/')) {
    return res.status(400).json({ error: 'Profile picture must be an image' });
  }

  try {
    const result = await uploadBuffer(req.file.buffer, {
      folder: 'nine/avatars',
      resourceType: 'image',
    });
    await pool.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [result.secure_url, req.userId]);
    res.json({ avatarUrl: result.secure_url });
  } catch (err) {
    console.error('Avatar upload error:', err);
    res.status(500).json({ error: 'Could not upload profile picture' });
  }
});

// POST /uploads/attachment — upload a file to attach to a chat message.
// This only uploads and returns a URL; sending the actual message
// (with this URL attached) happens over the socket in send_message.
router.post('/attachment', upload.single('file'), async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'File uploads are not configured on this server yet' });
  }
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const attachmentType = guessAttachmentType(req.file.mimetype);
  const resourceType = attachmentType === 'video' ? 'video'
    : (attachmentType === 'file' ? 'raw' : 'image');

  try {
    const result = await uploadBuffer(req.file.buffer, {
      folder: 'nine/attachments',
      resourceType,
    });
    res.json({
      url: result.secure_url,
      type: attachmentType,
      name: req.file.originalname,
    });
  } catch (err) {
    console.error('Attachment upload error:', err);
    res.status(500).json({ error: 'Could not upload file' });
  }
});

module.exports = router;
