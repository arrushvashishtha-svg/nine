// Calling now uses Jitsi Meet's free public server (meet.jit.si) via
// the frontend's JitsiMeetExternalAPI — no API key, no account, and no
// token needed from this backend at all. The call itself never touches
// this server; Socket.IO (see socket.js) only relays "hey, join this
// room" between the two users.
//
// This file is kept around only as a placeholder in case you want to
// add server-side call features later (e.g. call history logging,
// rate limiting, or moving to a self-hosted/JaaS Jitsi deployment that
// does require a signed token). Nothing in the frontend currently
// calls any route here.

const express = require('express');
const { requireAuth } = require('../utils/authMiddleware');

const router = express.Router();
router.use(requireAuth);

module.exports = router;
