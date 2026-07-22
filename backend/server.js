// Entry point. Run with: npm start (or npm run dev for auto-reload)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const pool = require('./db');
const authRoutes = require('./routes/auth');
const friendsRoutes = require('./routes/friends');
const { router: messagesRoutes } = require('./routes/messages');
const callsRoutes = require('./routes/calls');
const uploadsRoutes = require('./routes/uploads');
const { router: groupsRoutes } = require('./routes/groups');
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
app.use('/calls', callsRoutes);
app.use('/uploads', uploadsRoutes);
app.use('/groups', groupsRoutes);

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

// Run the database migration automatically on every boot. This is safe
// to run repeatedly because schema.sql only uses CREATE TABLE IF NOT
// EXISTS / CREATE INDEX IF NOT EXISTS — it's a no-op once tables exist.
// This exists because free-tier Render doesn't include Shell access,
// so there's no other easy way to run `npm run migrate` once.
async function runMigration() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('Database schema is up to date.');
  } catch (err) {
    console.error('Migration on startup failed:', err);
  }
}

const PORT = process.env.PORT || 4000;
runMigration().then(() => {
  server.listen(PORT, () => {
    console.log(`Nine backend listening on port ${PORT}`);
  });
});
