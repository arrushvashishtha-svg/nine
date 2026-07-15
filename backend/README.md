# Nine — backend

Chat app backend: no phone numbers, just username/password + a unique
1–9 digit ID number people use to send you friend requests. Real-time
chat and voice/video call signaling both run over Socket.IO.

## What's in this repo

```
server.js            entry point — Express + Socket.IO
db.js                Postgres connection pool
schema.sql           table definitions
migrate.js           runs schema.sql against your database
routes/auth.js        register / login
routes/friends.js     friend requests, accept/decline, privacy toggle, friend list
routes/messages.js     load past chat history
socket.js             live chat delivery, presence, WebRTC call signaling
utils/generateId.js   generates a unique friend ID number
utils/authMiddleware.js verifies login tokens on protected routes
.env.example          copy to .env and fill in
render.yaml           optional one-click Render deploy config
```

The matching frontend (`index.html` + `call.js`) is a separate folder —
point its `API_BASE` at wherever you deploy this backend.

## 1. Run it locally

You need Node.js installed and a Postgres database (local, or a free one
from Render — see step 3 below, you can use that connection string
locally too).

```bash
cd backend
npm install
cp .env.example .env
```

Open `.env` and fill in:
- `DATABASE_URL` — your Postgres connection string
- `JWT_SECRET` — generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `CLIENT_ORIGIN` — where your frontend runs, e.g. `http://localhost:5500`

Then create the tables and start the server:

```bash
npm run migrate
npm run dev
```

You should see `Nine backend listening on port 4000`. Test it's alive:

```bash
curl http://localhost:4000/health
```

## 2. Point the frontend at it

In `index.html`, before the main `<script>` block runs, set:

```html
<script>window.NINE_API_BASE = 'http://localhost:4000';</script>
```

(or whatever URL your backend runs on). Then just open `index.html` in
a browser, or serve it with any static file server.

## 3. Deploy for real — GitHub + Render

### Push to GitHub
```bash
cd backend
git init
git add .
git commit -m "Nine backend"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/nine-backend.git
git push -u origin main
```
Do the same for your frontend folder (either a separate repo, or a
`frontend/` folder in the same repo — either works).

### Create the database on Render
1. Render dashboard → **New +** → **PostgreSQL**
2. Give it a name, pick the **Free** plan, create it
3. Once it's ready, copy the **Internal Database URL** (or External if
   connecting from your own machine) — this is your `DATABASE_URL`

### Create the web service on Render
1. Render dashboard → **New +** → **Web Service**
2. Connect your GitHub repo
3. Root directory: `backend` (if it's a subfolder) or leave blank
4. Build command: `npm install`
5. Start command: `npm start`
6. Add environment variables in the Render dashboard:
   - `DATABASE_URL` → paste the one from your Postgres instance
   - `JWT_SECRET` → generate one (same command as above) and paste it
   - `CLIENT_ORIGIN` → your deployed frontend URL (add it after you deploy the frontend)
7. Deploy. Render will give you a URL like `https://nine-backend.onrender.com`

### Run the migration against the live database
Easiest way: temporarily change the Render start command to
`node migrate.js && node server.js`, deploy once, then change it back
to `npm start`. Or run it from your own machine using the database's
**External Database URL** in your local `.env`:
```bash
DATABASE_URL="paste_external_url_here" node migrate.js
```

### Deploy the frontend
Render also hosts static sites for free:
1. **New +** → **Static Site**, connect the frontend repo/folder
2. Publish directory: wherever `index.html` lives
3. Once deployed, go back to your backend's env vars on Render and set
   `CLIENT_ORIGIN` to this static site's URL, then redeploy the backend
   so CORS allows it
4. In your frontend's `index.html`, set `window.NINE_API_BASE` to your
   backend's Render URL

## 4. About voice/video calling

Calling uses WebRTC. This backend only relays *signaling* messages
(who wants to call whom, connection info) through Socket.IO — actual
audio/video travels directly between the two browsers, never through
this server. That means:

- It works out of the box for most networks using the free Google STUN
  server already configured in `call.js`
- Some networks (strict NAT, corporate firewalls) can't form a direct
  connection and need a TURN relay server. You don't need this until
  you notice calls failing to connect for specific users — see the
  comment at the bottom of `call.js` for options (coturn self-hosted,
  or hosted services like Twilio/Metered/Xirsys)

## 5. Security notes already built in

- Passwords are hashed with bcrypt, never stored in plain text
- Every chat/friend action re-checks friendship server-side — the
  client can't fake sending a message to a non-friend
- Friend ID numbers are enforced unique at the database level
- JWT tokens expire after 30 days; adjust in `routes/auth.js`
- Never commit your real `.env` file — it's already in `.gitignore`

## 6. New features — what you need to set up

### Voice/video calling (Daily.co)
Daily.co manages the entire call — peer connection, TURN relay, and the
call UI itself (video tiles, mute button, camera toggle, leave button)
all come from their embedded frame. Your backend just creates a room;
your frontend just joins it.
1. Sign up free at https://www.daily.co (no card required, free tier
   includes up to 5 simultaneous rooms)
2. Dashboard → Developers tab shows your API key
3. On your backend service in Render → Environment, add:
   - `DAILY_API_KEY`
4. Redeploy. Without this key, starting a call shows a friendly
   "calling is not configured yet" message instead of failing silently.

### Profile pictures, images, video, documents in chat (Cloudinary)
1. Sign up free at https://cloudinary.com
2. Dashboard shows **Cloud Name**, **API Key**, **API Secret**
3. On your backend service in Render → Environment, add:
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`
4. Redeploy. Without these, avatar/file uploads return a friendly error
   instead of failing silently.

### GIF search (GIPHY)
1. Sign up free at https://developers.giphy.com -> Create an App -> select API
2. Copy your API key (starts as a rate-limited beta key -- fine for personal use)
3. In frontend/index.html, find this line near the top and paste your key:
   window.NINE_GIPHY_KEY = 'paste-your-key-here';
4. Re-upload index.html, let the static site redeploy

### Re-run the migration after pulling these updates
The updated schema.sql adds new columns (avatar_url on users,
attachment_url/attachment_type/attachment_name on messages). Since
free-tier Render has no Shell access, this now runs automatically every
time your backend boots (see runMigration() in server.js) -- just
redeploy and check the logs for "Database schema is up to date."
