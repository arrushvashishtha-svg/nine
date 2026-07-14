// Entry point. Run with: npm start (or npm run dev for auto-reload)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const friendsRoutes = require('./routes/friends');
const { router: messagesRoutes } = require('./routes/messages');
const { initSocket } = require('./socket');

const app = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : '*',
  credentials: true,
}));
app.use(express.json());

// ---- HTTP routes ----
app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/auth', authRoutes);
app.use('/friends', friendsRoutes);
app.use('/messages', messagesRoutes);

// ---- Socket.IO ----
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : '*',
    credentials: true,
  },
});
initSocket(io);

// Make io reachable from HTTP routes if needed later
// (e.g. to push a 'friend_request' event right after the POST succeeds)
app.set('io', io);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Nine backend listening on port ${PORT}`);
});
