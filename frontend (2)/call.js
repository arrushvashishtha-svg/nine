/*
  call.js — voice/video calling using Daily.co.

  HOW THIS WORKS NOW:
  Daily.co handles the entire WebRTC layer for you — the peer connection,
  TURN relay, and media all happen inside their embedded call frame
  (an iframe they manage). You don't touch RTCPeerConnection or ICE
  candidates at all anymore.

  Flow:
  1. Caller asks the backend to create a Daily "room" (POST /calls/room)
  2. Caller sends the room URL to the callee via Socket.IO ('call:invite')
  3. Callee accepts -> both sides call daily-js's join() with that URL
  4. Daily's iframe renders the whole call UI (video tiles, mute button,
     camera toggle, etc.) inside the container element you give it

  Requires the Daily.co client library loaded on the page:
    <script src="https://unpkg.com/@daily-co/daily-js"></script>

  USAGE (wire this up in your main app.js):
    const call = new CallManager(socket, API_BASE, state.token);
    call.setContainer(document.getElementById('daily-call-container'));
    call.onIncomingCall = (fromUserId, callType) => { ...show incoming UI... };
    call.onCallStarted = () => { ...show call container, hide other UI... };
    call.onCallEnded = () => { ...hide call UI... };

    // to start a call:
    await call.startCall(friendUserId, 'video'); // or 'audio'

    // to accept an incoming call:
    await call.acceptCall();

    // to decline/hang up:
    call.declineCall();
    call.hangUp();
*/

class CallManager {
  constructor(socket, apiBase, authToken) {
    this.socket = socket;
    this.apiBase = apiBase;
    this.authToken = authToken;
    this.callFrame = null;
    this.containerEl = null;
    this.remoteUserId = null;
    this.pendingCallType = null;
    this.pendingRoomUrl = null;

    // Callbacks — set these from your UI code
    this.onIncomingCall = null;   // (fromUserId, callType) => {}
    this.onCallStarted = null;    // () => {} — call frame is about to render, show your call container
    this.onCallEnded = null;      // () => {}
    this.onCallDeclined = null;   // () => {}
    this.onCallUnavailable = null;// () => {} — friend is offline
    this.onCallError = null;      // (message) => {}

    this._bindSocketEvents();
  }

  _bindSocketEvents() {
    this.socket.on('call:incoming', ({ fromUserId, callType, roomUrl }) => {
      this.remoteUserId = fromUserId;
      this.pendingCallType = callType;
      this.pendingRoomUrl = roomUrl;
      this.onIncomingCall?.(fromUserId, callType);
    });

    this.socket.on('call:accepted', async () => {
      // We were the caller; the other side accepted — join the room now.
      await this._joinRoom(this.pendingRoomUrl, this.pendingCallType);
    });

    this.socket.on('call:declined', () => {
      this._cleanup();
      this.onCallDeclined?.();
    });

    this.socket.on('call:ended', () => {
      this._cleanup();
      this.onCallEnded?.();
    });

    this.socket.on('call:unavailable', () => {
      this._cleanup();
      this.onCallUnavailable?.();
    });
  }

  setContainer(containerEl) {
    this.containerEl = containerEl;
  }

  // ---- Caller side ----
  async startCall(toUserId, callType = 'video') {
    this.remoteUserId = toUserId;
    this.pendingCallType = callType;

    try {
      const res = await fetch(`${this.apiBase}/calls/room`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`,
        },
      });
      const data = await res.json();
      if (!res.ok) {
        this.onCallError?.(data.error || 'Could not start the call');
        return;
      }
      this.pendingRoomUrl = data.url;
      this.socket.emit('call:invite', { toUserId, callType, roomUrl: data.url });
    } catch (err) {
      console.error('[nine-call] failed to create room:', err);
      this.onCallError?.('Could not reach the calling service');
    }
  }

  // ---- Callee side ----
  async acceptCall() {
    this.socket.emit('call:accept', { toUserId: this.remoteUserId });
    await this._joinRoom(this.pendingRoomUrl, this.pendingCallType);
  }

  declineCall() {
    this.socket.emit('call:decline', { toUserId: this.remoteUserId });
    this._cleanup();
  }

  hangUp() {
    if (this.remoteUserId) {
      this.socket.emit('call:end', { toUserId: this.remoteUserId });
    }
    this._cleanup();
    this.onCallEnded?.();
  }

  // ---- Internals ----
  async _joinRoom(roomUrl, callType) {
    if (!roomUrl) {
      console.error('[nine-call] no room URL to join');
      this.onCallError?.('Could not join the call — missing room link');
      return;
    }
    if (!window.DailyIframe) {
      console.error('[nine-call] Daily.co script not loaded');
      this.onCallError?.('Calling library did not load — check your connection and try again');
      return;
    }

    console.log('[nine-call] joining room', roomUrl);
    this.onCallStarted?.();

    // Give the UI a tick to show the call container before we mount into it
    await new Promise(r => setTimeout(r, 0));

    this.callFrame = window.DailyIframe.createFrame(this.containerEl, {
      showLeaveButton: true,
      iframeStyle: {
        width: '100%',
        height: '100%',
        border: '0',
      },
    });

    this.callFrame.on('left-meeting', () => {
      this.hangUp();
    });
    this.callFrame.on('error', (e) => {
      console.error('[nine-call] Daily error:', e);
      this.onCallError?.('Call connection error: ' + (e?.errorMsg || 'unknown'));
    });

    try {
      await this.callFrame.join({
        url: roomUrl,
        startVideoOff: callType === 'audio',
      });
    } catch (err) {
      console.error('[nine-call] join failed:', err);
      this.onCallError?.('Could not join the call');
      this._cleanup();
    }
  }

  _cleanup() {
    if (this.callFrame) {
      try {
        this.callFrame.destroy();
      } catch (e) { /* already gone */ }
      this.callFrame = null;
    }
    this.remoteUserId = null;
    this.pendingCallType = null;
    this.pendingRoomUrl = null;
  }
}

/*
  ABOUT DAILY'S FREE TIER:
  - No card required to start
  - Up to 5 simultaneous active rooms on the free plan (fine for a
    personal project — rooms auto-expire 1 hour after creation, see
    the backend's /calls/room route, so old calls don't pile up)
  - If you outgrow this, Daily's paid tiers raise the room limit
*/
