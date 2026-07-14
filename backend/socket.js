// Real-time layer: live chat messages, online presence, and
// WebRTC signaling for voice/video calls.
//
// IMPORTANT ABOUT CALLING:
// Socket.IO here only relays the *signaling* messages (offer/answer/
// ICE candidates) between two browsers. The actual audio/video stream
// travels peer-to-peer over WebRTC, NOT through this server. This file
// does not send/receive any audio itself — your frontend needs to use
// the browser's WebRTC APIs (RTCPeerConnection, getUserMedia) and use
// these socket events to exchange connection info. See the frontend
// call.js file for the browser side of this.
//
// For most home/office networks a direct peer-to-peer connection works
// fine. Some networks (strict NATs, corporate firewalls) need a TURN
// relay server to connect at all — see the note at the bottom of this
// file about TURN servers.

const jwt = require('jsonwebtoken');
const pool = require('./db');
const { areFriends } = require('./routes/messages');

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
  return onlineUsers.has(userId);
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

    // ---------------- CHAT MESSAGES ----------------

    // Client sends: socket.emit('send_message', { toUserId, text })
    socket.on('send_message', async ({ toUserId, text }, ack) => {
      try {
        if (!toUserId || !text || !text.trim()) {
          return ack?.({ error: 'Missing message content' });
        }
        if (text.length > 4000) {
          return ack?.({ error: 'Message too long' });
        }

        // Never trust the client — re-check friendship server-side every time.
        const friends = await areFriends(userId, toUserId);
        if (!friends) {
          return ack?.({ error: 'You can only message friends' });
        }

        const { rows } = await pool.query(
          `INSERT INTO messages (sender_id, receiver_id, content)
           VALUES ($1, $2, $3)
           RETURNING id, sender_id, receiver_id, content, created_at`,
          [userId, toUserId, text.trim()]
        );
        const message = rows[0];

        // Deliver to every open tab/device the recipient has, if online
        const recipientSockets = onlineUsers.get(toUserId);
        if (recipientSockets) {
          for (const sockId of recipientSockets) {
            io.to(sockId).emit('receive_message', message);
          }
        }

        // Also echo back to the sender's other open tabs/devices
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

    // ---------------- FRIEND REQUEST PUSH ----------------
    // server.js calls io.to(...).emit('friend_request', ...) directly
    // from the HTTP route after a request is inserted — see server.js.

    // ---------------- CALL SIGNALING (WebRTC) ----------------
    // Flow: caller emits 'call:invite' -> callee gets it, shows incoming
    // call UI -> callee emits 'call:accept' or 'call:decline' -> if
    // accepted, both sides exchange 'call:signal' events (SDP offer/
    // answer + ICE candidates) until the peer connection is established.

    socket.on('call:invite', async ({ toUserId, callType }) => {
      // callType: 'audio' | 'video'
      const friends = await areFriends(userId, toUserId).catch(() => false);
      if (!friends) return;

      const targetSockets = onlineUsers.get(toUserId);
      if (!targetSockets || targetSockets.size === 0) {
        socket.emit('call:unavailable', { toUserId });
        return;
      }
      for (const sockId of targetSockets) {
        io.to(sockId).emit('call:incoming', { fromUserId: userId, callType });
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

    // Generic relay for SDP offers/answers and ICE candidates.
    // payload: { toUserId, data } — `data` is whatever the WebRTC API gave you
    socket.on('call:signal', ({ toUserId, data }) => {
      relayToUser(io, toUserId, 'call:signal', { fromUserId: userId, data });
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
  const sockets = onlineUsers.get(toUserId);
  if (!sockets) return;
  for (const sockId of sockets) {
    io.to(sockId).emit(event, payload);
  }
}

// Tell a user's friends when they come online/offline.
// (Simple version: broadcast to everyone; fine for small apps. For scale,
// look up the user's friend list and only notify those.)
async function broadcastPresence(io, userId, online) {
  try {
    const { rows } = await pool.query(
      'SELECT friend_id AS other_user_id FROM friendships WHERE user_id = $1',
      [userId]
    );
    for (const row of rows) {
      relayToUser(io, row.other_user_id, 'presence', { userId, online });
    }
  } catch (err) {
    console.error('broadcastPresence error:', err);
  }
}

module.exports = { initSocket, onlineUsers, relayToUser };
