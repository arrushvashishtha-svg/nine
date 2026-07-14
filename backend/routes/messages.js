// Loading past messages over plain HTTP (Socket.IO handles the live sending).
// Real-time messages get saved here too — see socket.js — this file just
// covers "give me the conversation history when I open a chat."

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../utils/authMiddleware');

const router = express.Router();
router.use(requireAuth);

// helper also used by socket.js
async function areFriends(userA, userB) {
  const { rows } = await pool.query(
    'SELECT 1 FROM friendships WHERE user_id = $1 AND friend_id = $2',
    [userA, userB]
  );
  return rows.length > 0;
}

// GET /messages/:friendUserId — full history with one friend
router.get('/:friendUserId', async (req, res) => {
  const friendUserId = Number(req.params.friendUserId);
  if (!Number.isInteger(friendUserId)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const friends = await areFriends(req.userId, friendUserId);
  if (!friends) {
    return res.status(403).json({ error: 'You can only view messages with friends' });
  }

  const { rows } = await pool.query(
    `SELECT id, sender_id, receiver_id, content, created_at
     FROM messages
     WHERE (sender_id = $1 AND receiver_id = $2)
        OR (sender_id = $2 AND receiver_id = $1)
     ORDER BY created_at ASC
     LIMIT 200`,
    [req.userId, friendUserId]
  );

  res.json({ messages: rows });
});

module.exports = { router, areFriends };
