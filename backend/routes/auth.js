// Registration and login. No phone numbers anywhere — just
// username + password, and we hand back a unique friend_id on signup.

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { generateUniqueFriendId } = require('../utils/generateId');
const { requireAuth } = require('../utils/authMiddleware');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    friendId: row.friend_id,
    isPrivate: row.is_private,
    avatarUrl: row.avatar_url,
  };
}

// POST /auth/register  { username, password }
router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscores only' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await pool.query(
      'SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'That username is taken' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const friendId = await generateUniqueFriendId(6);

    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, friend_id, is_private)
       VALUES ($1, $2, $3, false)
       RETURNING id, username, friend_id, is_private, avatar_url`,
      [username, passwordHash, friendId]
    );

    const user = rows[0];
    const token = signToken(user.id);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Something went wrong creating your account' });
  }
});

// POST /auth/login  { username, password }
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const { rows } = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = signToken(user.id);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong logging you in' });
  }
});

// GET /auth/me — verifies a saved token is still valid and returns the
// current user. Used on page load to silently resume a session instead
// of forcing a fresh username/password login every time.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, friend_id, is_private, avatar_url FROM users WHERE id = $1',
      [req.userId]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }
    res.json({ user: publicUser(rows[0]) });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Could not verify session' });
  }
});

module.exports = router;
