// Friend requests, friend list, and the privacy toggle.
// Every route here requires a valid login (see requireAuth).

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../utils/authMiddleware');

const router = express.Router();
router.use(requireAuth);

// PATCH /friends/privacy  { isPrivate: boolean }
router.patch('/privacy', async (req, res) => {
  const { isPrivate } = req.body;
  if (typeof isPrivate !== 'boolean') {
    return res.status(400).json({ error: 'isPrivate must be true or false' });
  }
  await pool.query('UPDATE users SET is_private = $1 WHERE id = $2', [isPrivate, req.userId]);
  res.json({ isPrivate });
});

// POST /friends/request/:friendId   — send a friend request by ID number
router.post('/request/:friendId', async (req, res) => {
  try {
    const { friendId } = req.params;

    if (!/^\d{1,9}$/.test(friendId)) {
      return res.status(400).json({ error: 'IDs are 1-9 digits only' });
    }

    const { rows: targetRows } = await pool.query(
      'SELECT id, username FROM users WHERE friend_id = $1',
      [friendId]
    );
    if (targetRows.length === 0) {
      return res.status(404).json({ error: 'No account with that ID' });
    }
    const target = targetRows[0];

    if (target.id === req.userId) {
      return res.status(400).json({ error: "That's your own ID" });
    }

    // already friends?
    const { rows: existingFriend } = await pool.query(
      'SELECT 1 FROM friendships WHERE user_id = $1 AND friend_id = $2',
      [req.userId, target.id]
    );
    if (existingFriend.length > 0) {
      return res.status(409).json({ error: 'You are already friends' });
    }

    // Rate-limit-ish: block duplicate pending requests (also enforced by UNIQUE in DB)
    await pool.query(
      `INSERT INTO friend_requests (sender_id, receiver_id, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (sender_id, receiver_id)
       DO UPDATE SET status = 'pending', created_at = now()
       WHERE friend_requests.status = 'declined'`,
      [req.userId, target.id]
    );

    // Push a live notification if the recipient is online right now.
    const io = req.app.get('io');
    if (io) {
      const { onlineUsers } = require('../socket');
      const sockets = onlineUsers.get(target.id);
      if (sockets) {
        const senderInfo = await pool.query(
          'SELECT username, friend_id FROM users WHERE id = $1',
          [req.userId]
        );
        for (const sockId of sockets) {
          io.to(sockId).emit('friend_request', {
            fromUserId: req.userId,
            username: senderInfo.rows[0].username,
            friendId: senderInfo.rows[0].friend_id,
          });
        }
      }
    }

    res.status(201).json({ sentTo: target.username });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already sent a request to this person' });
    }
    console.error('Friend request error:', err);
    res.status(500).json({ error: 'Could not send friend request' });
  }
});

// GET /friends/requests — incoming pending requests
router.get('/requests', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT fr.id, u.id AS user_id, u.username, u.friend_id, u.avatar_url
     FROM friend_requests fr
     JOIN users u ON u.id = fr.sender_id
     WHERE fr.receiver_id = $1 AND fr.status = 'pending'
     ORDER BY fr.created_at DESC`,
    [req.userId]
  );
  res.json({ requests: rows });
});

// POST /friends/requests/:requestId/accept
router.post('/requests/:requestId/accept', async (req, res) => {
  const client = await pool.connect();
  try {
    const { requestId } = req.params;
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM friend_requests WHERE id = $1 AND receiver_id = $2 AND status = 'pending'`,
      [requestId, req.userId]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Request not found' });
    }
    const request = rows[0];

    await client.query(`UPDATE friend_requests SET status = 'accepted' WHERE id = $1`, [requestId]);

    // insert both directions so either user's friend list finds the other
    await client.query(
      `INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2), ($2, $1)
       ON CONFLICT DO NOTHING`,
      [request.sender_id, request.receiver_id]
    );

    await client.query('COMMIT');
    res.json({ accepted: true, friendUserId: request.sender_id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Accept request error:', err);
    res.status(500).json({ error: 'Could not accept request' });
  } finally {
    client.release();
  }
});

// POST /friends/requests/:requestId/decline
router.post('/requests/:requestId/decline', async (req, res) => {
  const { requestId } = req.params;
  const { rows } = await pool.query(
    `UPDATE friend_requests SET status = 'declined'
     WHERE id = $1 AND receiver_id = $2 AND status = 'pending'
     RETURNING id`,
    [requestId, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });
  res.json({ declined: true });
});

// GET /friends — your accepted friends list
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.friend_id, u.avatar_url
     FROM friendships f
     JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = $1
     ORDER BY u.username ASC`,
    [req.userId]
  );
  res.json({ friends: rows });
});

module.exports = router;
