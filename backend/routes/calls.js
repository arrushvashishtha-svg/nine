// Generates short-lived Agora tokens so two friends can join the same
// voice/video "channel". Agora's SDK handles the entire WebRTC layer —
// peer connection, routing, and media — on their global network.
//
// Sign up free at https://www.agora.io (no credit card required; 10,000
// free minutes/month, shared across all your projects). In the Agora
// Console, create a project to get your App ID and App Certificate.

const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-token');
const { requireAuth } = require('../utils/authMiddleware');

const router = express.Router();
router.use(requireAuth);

// POST /calls/token  { channelName }
// Both participants call this with the SAME channelName (we use a
// deterministic name built from both user IDs, sorted, so either side
// generates the same string) and each gets back their own token.
router.post('/token', async (req, res) => {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCertificate) {
    return res.status(503).json({ error: 'Calling is not configured on this server yet' });
  }

  const { channelName } = req.body;
  if (!channelName || typeof channelName !== 'string' || channelName.length > 64) {
    return res.status(400).json({ error: 'Invalid channel name' });
  }

  try {
    const uid = req.userId; // Agora uses this as the participant's identifier in the channel
    const role = RtcRole.PUBLISHER;
    const expireSeconds = 60 * 60; // 1 hour — plenty for a call, short-lived for safety
    const currentTs = Math.floor(Date.now() / 1000);
    const privilegeExpireTs = currentTs + expireSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId, appCertificate, channelName, uid, role, privilegeExpireTs, privilegeExpireTs
    );

    res.json({ token, appId, uid, channelName });
  } catch (err) {
    console.error('Agora token generation error:', err);
    res.status(500).json({ error: 'Could not generate call token' });
  }
});

module.exports = router;
