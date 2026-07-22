// Group chats. Anyone can create a group from their friends list; the
// creator is an admin from the start. Only admins can add/remove members,
// promote other admins, or rename the group. Any member can post messages.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../utils/authMiddleware');

const router = express.Router();
router.use(requireAuth);

// helper also used by socket.js
async function isGroupMember(groupId, userId) {
  const { rows } = await pool.query(
    'SELECT is_admin FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return rows.length > 0 ? { member: true, isAdmin: rows[0].is_admin } : { member: false, isAdmin: false };
}

// POST /groups  { name, memberIds: [userId, ...] }
// memberIds should be friends of the creator — every id is checked server-side.
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, memberIds } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ error: 'Pick at least one friend to add' });
    }

    const ids = [...new Set(memberIds.map(Number))].filter(id => id !== req.userId);

    // Every member being added must actually be a friend of the creator —
    // never trust the client's list at face value.
    const { rows: friendRows } = await client.query(
      'SELECT friend_id FROM friendships WHERE user_id = $1 AND friend_id = ANY($2::int[])',
      [req.userId, ids]
    );
    const validIds = friendRows.map(r => r.friend_id);
    if (validIds.length !== ids.length) {
      return res.status(400).json({ error: 'You can only add your friends to a group' });
    }

    await client.query('BEGIN');

    const { rows: groupRows } = await client.query(
      'INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id, name, avatar_url, created_by, created_at',
      [name.trim().slice(0, 64), req.userId]
    );
    const group = groupRows[0];

    const allMemberIds = [req.userId, ...validIds];
    const values = allMemberIds.map((_, i) => `($1, $${i + 2}, $${i === 0 ? 'true' : 'false'})`);
    // Build values manually to set creator as admin, everyone else not
    for (const uid of allMemberIds) {
      await client.query(
        'INSERT INTO group_members (group_id, user_id, is_admin) VALUES ($1, $2, $3)',
        [group.id, uid, uid === req.userId]
      );
    }

    await client.query('COMMIT');

    // Notify anyone online that they've been added
    const io = req.app.get('io');
    if (io) {
      const { onlineUsers } = require('../socket');
      const { rows: memberInfo } = await pool.query(
        `SELECT u.id, u.username, u.friend_id, u.avatar_url, gm.is_admin
         FROM group_members gm JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = $1`,
        [group.id]
      );
      for (const uid of validIds) {
        const sockets = onlineUsers.get(uid);
        if (sockets) {
          for (const sockId of sockets) {
            io.to(sockId).emit('group:added', { group: { ...group, members: memberInfo } });
          }
        }
      }
    }

    const { rows: memberInfo } = await pool.query(
      `SELECT u.id, u.username, u.friend_id, u.avatar_url, gm.is_admin
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1`,
      [group.id]
    );
    res.status(201).json({ group: { ...group, members: memberInfo } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create group error:', err);
    res.status(500).json({ error: 'Could not create group' });
  } finally {
    client.release();
  }
});

// GET /groups — all groups you're a member of, with member lists
router.get('/', async (req, res) => {
  try {
    const { rows: groupRows } = await pool.query(
      `SELECT g.id, g.name, g.avatar_url, g.created_by, g.created_at
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = $1
       ORDER BY g.created_at DESC`,
      [req.userId]
    );

    const groups = [];
    for (const g of groupRows) {
      const { rows: members } = await pool.query(
        `SELECT u.id, u.username, u.friend_id, u.avatar_url, gm.is_admin
         FROM group_members gm JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = $1`,
        [g.id]
      );
      groups.push({ ...g, members });
    }

    res.json({ groups });
  } catch (err) {
    console.error('List groups error:', err);
    res.status(500).json({ error: 'Could not load groups' });
  }
});

// GET /groups/:groupId/messages — history
router.get('/:groupId/messages', async (req, res) => {
  const groupId = Number(req.params.groupId);
  const { member } = await isGroupMember(groupId, req.userId);
  if (!member) return res.status(403).json({ error: 'You are not in this group' });

  const { rows } = await pool.query(
    `SELECT id, group_id, sender_id, content, attachment_url, attachment_type, attachment_name, created_at
     FROM group_messages WHERE group_id = $1 ORDER BY created_at ASC LIMIT 200`,
    [groupId]
  );
  res.json({ messages: rows });
});

// POST /groups/:groupId/members  { userId } — admin only, must be a friend of the admin
router.post('/:groupId/members', async (req, res) => {
  const groupId = Number(req.params.groupId);
  const { userId } = req.body;
  const { member, isAdmin } = await isGroupMember(groupId, req.userId);
  if (!member || !isAdmin) return res.status(403).json({ error: 'Only group admins can add members' });

  try {
    const { rows: friendCheck } = await pool.query(
      'SELECT 1 FROM friendships WHERE user_id = $1 AND friend_id = $2',
      [req.userId, userId]
    );
    if (friendCheck.length === 0) {
      return res.status(400).json({ error: 'You can only add your own friends' });
    }

    await pool.query(
      'INSERT INTO group_members (group_id, user_id, is_admin) VALUES ($1, $2, false) ON CONFLICT DO NOTHING',
      [groupId, userId]
    );

    const io = req.app.get('io');
    if (io) {
      const { onlineUsers, relayToUser } = require('../socket');
      const { rows: groupRow } = await pool.query('SELECT id, name, avatar_url, created_by, created_at FROM groups WHERE id = $1', [groupId]);
      const { rows: members } = await pool.query(
        `SELECT u.id, u.username, u.friend_id, u.avatar_url, gm.is_admin
         FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = $1`,
        [groupId]
      );
      const fullGroup = { ...groupRow[0], members };
      relayToUser(io, Number(userId), 'group:added', { group: fullGroup });
      for (const m of members) {
        if (m.id !== Number(userId)) relayToUser(io, m.id, 'group:updated', { group: fullGroup });
      }
    }

    res.json({ added: true });
  } catch (err) {
    console.error('Add group member error:', err);
    res.status(500).json({ error: 'Could not add member' });
  }
});

// DELETE /groups/:groupId/members/:userId — admin only (or self-leave)
router.delete('/:groupId/members/:userId', async (req, res) => {
  const groupId = Number(req.params.groupId);
  const targetId = Number(req.params.userId);
  const { member, isAdmin } = await isGroupMember(groupId, req.userId);
  if (!member) return res.status(403).json({ error: 'You are not in this group' });

  const isSelfLeave = targetId === req.userId;
  if (!isSelfLeave && !isAdmin) {
    return res.status(403).json({ error: 'Only group admins can remove members' });
  }

  try {
    await pool.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, targetId]);

    const io = req.app.get('io');
    if (io) {
      const { relayToUser } = require('../socket');
      relayToUser(io, targetId, 'group:removed', { groupId });
      const { rows: members } = await pool.query(
        `SELECT u.id FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = $1`,
        [groupId]
      );
      for (const m of members) relayToUser(io, m.id, 'group:member_left', { groupId, userId: targetId });
    }

    res.json({ removed: true });
  } catch (err) {
    console.error('Remove group member error:', err);
    res.status(500).json({ error: 'Could not remove member' });
  }
});

// PATCH /groups/:groupId/admins/:userId  { isAdmin: boolean } — admin only
router.patch('/:groupId/admins/:userId', async (req, res) => {
  const groupId = Number(req.params.groupId);
  const targetId = Number(req.params.userId);
  const { isAdmin: requesterIsAdmin } = await isGroupMember(groupId, req.userId);
  if (!requesterIsAdmin) return res.status(403).json({ error: 'Only group admins can promote others' });

  const { isAdmin } = req.body;
  if (typeof isAdmin !== 'boolean') return res.status(400).json({ error: 'isAdmin must be true or false' });

  try {
    await pool.query('UPDATE group_members SET is_admin = $1 WHERE group_id = $2 AND user_id = $3', [isAdmin, groupId, targetId]);

    const io = req.app.get('io');
    if (io) {
      const { relayToUser } = require('../socket');
      const { rows: members } = await pool.query(
        `SELECT u.id FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = $1`,
        [groupId]
      );
      for (const m of members) relayToUser(io, m.id, 'group:admin_changed', { groupId, userId: targetId, isAdmin });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Promote admin error:', err);
    res.status(500).json({ error: 'Could not update admin status' });
  }
});

// PATCH /groups/:groupId  { name } — admin only, rename
router.patch('/:groupId', async (req, res) => {
  const groupId = Number(req.params.groupId);
  const { isAdmin } = await isGroupMember(groupId, req.userId);
  if (!isAdmin) return res.status(403).json({ error: 'Only group admins can rename the group' });

  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Group name is required' });

  try {
    await pool.query('UPDATE groups SET name = $1 WHERE id = $2', [name.trim().slice(0, 64), groupId]);

    const io = req.app.get('io');
    if (io) {
      const { relayToUser } = require('../socket');
      const { rows: members } = await pool.query(
        `SELECT u.id FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = $1`,
        [groupId]
      );
      for (const m of members) relayToUser(io, m.id, 'group:renamed', { groupId, name: name.trim().slice(0, 64) });
    }

    res.json({ renamed: true });
  } catch (err) {
    console.error('Rename group error:', err);
    res.status(500).json({ error: 'Could not rename group' });
  }
});

module.exports = { router, isGroupMember };
