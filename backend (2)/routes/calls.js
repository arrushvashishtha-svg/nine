// Creates Daily.co video call rooms on demand. Daily handles the entire
// WebRTC layer (peer connection, TURN relay, media) — our job is just
// to create a short-lived room and hand both participants the URL.
//
// Sign up free at https://www.daily.co (free tier includes up to 5
// simultaneous rooms, no card required). Dashboard -> Developers tab
// has your API key. Put it in .env as DAILY_API_KEY.

const express = require('express');
const { requireAuth } = require('../utils/authMiddleware');

const router = express.Router();
router.use(requireAuth);

// POST /calls/room — creates a new short-lived Daily room for a 1:1 call.
// Both the caller and callee join the same room URL.
router.post('/room', async (req, res) => {
  const apiKey = process.env.DAILY_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Calling is not configured on this server yet' });
  }

  try {
    const response = await fetch('https://api.daily.co/v1/rooms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        properties: {
          // Room auto-expires 1 hour after creation so free-tier room
          // limits never fill up with abandoned calls.
          exp: Math.floor(Date.now() / 1000) + 60 * 60,
          eject_at_room_exp: true,
          enable_chat: false,
          enable_screenshare: true,
          start_video_off: false,
          start_audio_off: false,
        },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Daily room creation failed:', response.status, errBody);
      return res.status(502).json({ error: 'Could not create call room' });
    }

    const room = await response.json();
    res.json({ url: room.url, name: room.name });
  } catch (err) {
    console.error('Daily room creation error:', err);
    res.status(500).json({ error: 'Could not create call room' });
  }
});

module.exports = router;

