// Real-time layer: live chat messages, typing indicators, online
// presence, group chat, and WebRTC/Agora call signaling.

const jwt = require('jsonwebtoken');
const pool = require('./db');
const { areFriends } = require('./routes/messages');
const { isGroupMember } = require('./routes/groups');

// Track which socket(s) belong to which user id, so we can push events
// to a specific person. A user can have multiple tabs/devices open,
// hence an array/Set of socket ids per user.
const onlineUsers = new Map(); // userId -> Set<socketId>

function addOnlineSocket(userId, socketId) {
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socketId);
}

function removeOnlineSocket(userId, socketId) {
  const set = onlineUsers.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) onlineUsers.delete(userId);
}

function isOnline(userId) {
  const set = onlineUsers.get(Number(userId));
  return !!(set && set.size > 0);
}

function initSocket(io) {
  // Auth handshake: client must connect with { auth: { token } }
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Missing auth token'));
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = payload.userId;
      next();
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    addOnlineSocket(userId, socket.id);
    broadcastPresence(io, userId, true);

    // Client can ask "who among my friends is online right now?" right
    // after connecting, as a belt-and-suspenders alongside the
    // GET /friends online flag — covers the case where the socket
    // connects a moment before/after the initial friends fetch.
    socket.on('get_online_friends', async (_, ack) => {
      try {
        const { rows } = await pool.query(
          'SELECT friend_id AS other_user_id FROM friendships WHERE user_id = $1',
          [userId]
        );
        const online = rows.map(r => r.other_user_id).filter(isOnline);
        ack?.({ online });
      } catch (err) {
        ack?.({ online: [] });
      }
    });

    // ---------------- CHAT MESSAGES (1:1) ----------------

    socket.on('send_message', async ({ toUserId, text, attachment }, ack) => {
      try {
        const hasText = text && text.trim();
        const hasAttachment = attachment && attachment.url;
        if (!toUserId || (!hasText && !hasAttachment)) {
          return ack?.({ error: 'Missing message content' });
        }
        if (hasText && text.length > 4000) {
          return ack?.({ error: 'Message too long' });
        }

        const friends = await areFriends(userId, toUserId);
        if (!friends) {
          return ack?.({ error: 'You can only message friends' });
        }

        const { rows } = await pool.query(
          `INSERT INTO messages (sender_id, receiver_id, content, attachment_url, attachment_type, attachment_name)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, sender_id, receiver_id, content, attachment_url, attachment_type, attachment_name, created_at`,
          [
            userId, toUserId,
            hasText ? text.trim() : null,
            hasAttachment ? attachment.url : null,
            hasAttachment ? attachment.type : null,
            hasAttachment ? (attachment.name || null) : null,
          ]
        );
        const message = rows[0];

        const recipientSockets = onlineUsers.get(toUserId);
        if (recipientSockets) {
          for (const sockId of recipientSockets) {
            io.to(sockId).emit('receive_message', message);
          }
        }

        const senderSockets = onlineUsers.get(userId);
        if (senderSockets) {
          for (const sockId of senderSockets) {
            if (sockId !== socket.id) io.to(sockId).emit('receive_message', message);
          }
        }

        ack?.({ message });
      } catch (err) {
        console.error('send_message error:', err);
        ack?.({ error: 'Could not send message' });
      }
    });

    // ---------------- TYPING INDICATORS (1:1) ----------------
    // Fire-and-forget, no ack needed. Client should debounce/throttle
    // 'typing:start' on keystrokes and send 'typing:stop' on blur/send/
    // after a pause — see frontend.

    socket.on('typing:start', async ({ toUserId }) => {
      if (!toUserId) return;
      const friends = await areFriends(userId, toUserId).catch(() => false);
      if (!friends) return;
      relayToUser(io, toUserId, 'typing:start', { fromUserId: userId });
    });

    socket.on('typing:stop', async ({ toUserId }) => {
      if (!toUserId) return;
      relayToUser(io, toUserId, 'typing:stop', { fromUserId: userId });
    });

    // ---------------- GROUP CHAT ----------------

    socket.on('group:send_message', async ({ groupId, text, attachment }, ack) => {
      try {
        const hasText = text && text.trim();
        const hasAttachment = attachment && attachment.url;
        if (!groupId || (!hasText && !hasAttachment)) {
          return ack?.({ error: 'Missing message content' });
        }
        if (hasText && text.length > 4000) {
          return ack?.({ error: 'Message too long' });
        }

        const { member } = await isGroupMember(groupId, userId);
        if (!member) return ack?.({ error: 'You are not in this group' });

        const { rows } = await pool.query(
          `INSERT INTO group_messages (group_id, sender_id, content, attachment_url, attachment_type, attachment_name)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, group_id, sender_id, content, attachment_url, attachment_type, attachment_name, created_at`,
          [
            groupId, userId,
            hasText ? text.trim() : null,
            hasAttachment ? attachment.url : null,
            hasAttachment ? attachment.type : null,
            hasAttachment ? (attachment.name || null) : null,
          ]
        );
        const message = rows[0];

        const { rows: members } = await pool.query(
          'SELECT user_id FROM group_members WHERE group_id = $1',
          [groupId]
        );
        for (const m of members) {
          const sockets = onlineUsers.get(m.user_id);
          if (!sockets) continue;
          for (const sockId of sockets) {
            io.to(sockId).emit('group:receive_message', message);
          }
        }

        ack?.({ message });
      } catch (err) {
        console.error('group:send_message error:', err);
        ack?.({ error: 'Could not send message' });
      }
    });

    socket.on('group:typing:start', async ({ groupId }) => {
      if (!groupId) return;
      const { member } = await isGroupMember(groupId, userId).catch(() => ({ member: false }));
      if (!member) return;
      const { rows: members } = await pool.query(
        'SELECT user_id FROM group_members WHERE group_id = $1',
        [groupId]
      ).catch(() => ({ rows: [] }));
      for (const m of members) {
        if (m.user_id === userId) continue;
        relayToUser(io, m.user_id, 'group:typing:start', { groupId, fromUserId: userId });
      }
    });

    socket.on('group:typing:stop', async ({ groupId }) => {
      if (!groupId) return;
      const { rows: members } = await pool.query(
        'SELECT user_id FROM group_members WHERE group_id = $1',
        [groupId]
      ).catch(() => ({ rows: [] }));
      for (const m of members) {
        if (m.user_id === userId) continue;
        relayToUser(io, m.user_id, 'group:typing:stop', { groupId, fromUserId: userId });
      }
    });

    // ---------------- FRIEND REQUEST / ACCEPT PUSH ----------------
    // server.js / routes/friends.js call io.to(...).emit(...) directly
    // from the HTTP routes after DB writes succeed.

    // ---------------- CALL SIGNALING (Agora) ----------------

    socket.on('call:invite', async ({ toUserId, callType, channelName }) => {
      const friends = await areFriends(userId, toUserId).catch(() => false);
      if (!friends) return;

      const targetSockets = onlineUsers.get(toUserId);
      if (!targetSockets || targetSockets.size === 0) {
        socket.emit('call:unavailable', { toUserId });
        return;
      }
      for (const sockId of targetSockets) {
        io.to(sockId).emit('call:incoming', { fromUserId: userId, callType, channelName });
      }
    });

    socket.on('call:accept', ({ toUserId }) => {
      relayToUser(io, toUserId, 'call:accepted', { fromUserId: userId });
    });

    socket.on('call:decline', ({ toUserId }) => {
      relayToUser(io, toUserId, 'call:declined', { fromUserId: userId });
    });

    socket.on('call:end', ({ toUserId }) => {
      relayToUser(io, toUserId, 'call:ended', { fromUserId: userId });
    });

    // ---------------- DISCONNECT ----------------
    socket.on('disconnect', () => {
      removeOnlineSocket(userId, socket.id);
      if (!isOnline(userId)) {
        broadcastPresence(io, userId, false);
      }
    });
  });
}

function relayToUser(io, toUserId, event, payload) {
  const sockets = onlineUsers.get(Number(toUserId));
  if (!sockets) return;
  for (const sockId of sockets) {
    io.to(sockId).emit(event, payload);
  }
}

// Tell a user's friends AND group co-members when they come online/offline.
async function broadcastPresence(io, userId, online) {
  try {
    const { rows: friendRows } = await pool.query(
      'SELECT friend_id AS other_user_id FROM friendships WHERE user_id = $1',
      [userId]
    );
    const notified = new Set();
    for (const row of friendRows) {
      relayToUser(io, row.other_user_id, 'presence', { userId, online });
      notified.add(row.other_user_id);
    }

    // Also notify group co-members who may not be direct friends
    const { rows: groupmateRows } = await pool.query(
      `SELECT DISTINCT gm2.user_id AS other_user_id
       FROM group_members gm1
       JOIN group_members gm2 ON gm2.group_id = gm1.group_id
       WHERE gm1.user_id = $1 AND gm2.user_id != $1`,
      [userId]
    );
    for (const row of groupmateRows) {
      if (notified.has(row.other_user_id)) continue;
      relayToUser(io, row.other_user_id, 'presence', { userId, online });
    }
  } catch (err) {
    console.error('broadcastPresence error:', err);
  }
}

module.exports = { initSocket, onlineUsers, relayToUser, isOnline };
