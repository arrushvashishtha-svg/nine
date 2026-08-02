// Calling uses raw WebRTC with Google's free public STUN servers,
// hardcoded directly in the frontend's call.js — no API key, no
// account, no company's server in the middle, and no backend call
// needed to get STUN config. Socket.IO (see socket.js) only relays
// signaling messages (offer/answer/ICE candidates) between the two
// browsers; the actual call audio/video never touches this server.
//
// This file is kept around as a placeholder in case you want to add
// server-side call features later (e.g. call history logging, or a
// TURN relay's credentials if you ever add one — Cloudflare Calls and
// Metered.ca both have free tiers that would slot in here). Nothing in
// the frontend currently calls any route in this file.

const express = require('express');
const { requireAuth } = require('../utils/authMiddleware');

const router = express.Router();
router.use(requireAuth);

module.exports = router;
