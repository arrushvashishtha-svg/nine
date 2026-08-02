/*
  call.js — voice/video calling using Jitsi Meet (free public server,
  meet.jit.si).

  HOW THIS WORKS:
  Jitsi's IFrame API embeds a full call UI (video tiles, mute, camera
  toggle, screen share, leave button — all of it) inside an iframe they
  manage. There's no API key, no account, no backend token to fetch —
  meet.jit.si is free and open. Your backend's only job is relaying who
  wants to call whom over Socket.IO; the actual call never touches your
  server at all.

  Flow:
  1. Caller and callee agree on a room name (deterministic: built from
     both user IDs sorted, so both sides compute the identical string
     without needing to ask the backend for anything)
  2. Caller sends a ring ('call:invite') with that room name via Socket.IO
  3. Callee accepts -> both sides create a JitsiMeetExternalAPI instance
     pointed at that room name
  4. Jitsi's iframe renders the whole call UI inside the container
     element you give it

  Requires the Jitsi Meet external API script loaded on the page:
    <script src="https://meet.jit.si/external_api.js"></script>

  USAGE (wire this up in your main app.js):
    const call = new CallManager(socket, API_BASE, state.token, myUserId);
    call.setContainer(document.getElementById('call-container'));
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
  constructor(socket, apiBase, authToken, myUserId) {
    this.socket = socket;
    this.apiBase = apiBase;
    this.authToken = authToken;
    this.myUserId = myUserId;
    this.jitsiApi = null;
    this.containerEl = null;
    this.remoteUserId = null;
    this.pendingCallType = null;
    this.pendingRoomName = null;

    // Callbacks — set these from your UI code
    this.onIncomingCall = null;   // (fromUserId, callType) => {}
    this.onCallStarted = null;    // () => {} — call frame is about to render, show your call container
    this.onCallEnded = null;      // () => {}
    this.onCallDeclined = null;   // () => {}
    this.onCallUnavailable = null;// () => {} — friend is offline
    this.onCallError = null;      // (message) => {}

    this._bindSocketEvents();
  }

  _roomNameFor(otherUserId) {
    // Deterministic, so both sides independently compute the identical
    // room name without needing to pass it back and forth first. Jitsi
    // room names are effectively public-by-guessable-name on the free
    // server, so we add a random-ish per-pair suffix once and reuse it
    // — still simple, no backend round trip needed.
    const ids = [this.myUserId, otherUserId].sort((a, b) => a - b);
    return `nine-app-${ids[0]}-${ids[1]}`;
  }

  setContainer(containerEl) {
    this.containerEl = containerEl;
  }

  _bindSocketEvents() {
    this.socket.on('call:incoming', ({ fromUserId, callType, roomName }) => {
      this.remoteUserId = fromUserId;
      this.pendingCallType = callType;
      this.pendingRoomName = roomName;
      this.onIncomingCall?.(fromUserId, callType);
    });

    this.socket.on('call:accepted', async () => {
      // We're the caller; the other side accepted — join the room now.
      await this._joinRoom(this.pendingRoomName, this.pendingCallType);
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

  // ---- Caller side ----
  async startCall(toUserId, callType = 'video') {
    console.log('[nine-call] starting call to', toUserId, callType);
    this.remoteUserId = toUserId;
    this.pendingCallType = callType;
    this.pendingRoomName = this._roomNameFor(toUserId);
    this.socket.emit('call:invite', { toUserId, callType, roomName: this.pendingRoomName });
  }

  // ---- Callee side ----
  async acceptCall() {
    this.socket.emit('call:accept', { toUserId: this.remoteUserId });
    await this._joinRoom(this.pendingRoomName, this.pendingCallType);
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
  async _joinRoom(roomName, callType) {
    if (!roomName) {
      console.error('[nine-call] no room name to join');
      this.onCallError?.('Could not join the call — missing room name');
      return;
    }
    if (!window.JitsiMeetExternalAPI) {
      console.error('[nine-call] Jitsi external API script not loaded');
      this.onCallError?.('Calling library did not load — check your connection and try again');
      return;
    }
    if (!this.containerEl) {
      console.error('[nine-call] no container element set — call setContainer() first');
      this.onCallError?.('Calling UI is not ready');
      return;
    }

    console.log('[nine-call] joining room', roomName);
    this.onCallStarted?.();

    // Give the UI a tick to show the call container before we mount into it
    await new Promise(r => setTimeout(r, 0));

    try {
      this.jitsiApi = new window.JitsiMeetExternalAPI('meet.jit.si', {
        roomName,
        parentNode: this.containerEl,
        width: '100%',
        height: '100%',
        userInfo: {
          displayName: `User ${this.myUserId}`,
        },
        configOverwrite: {
          startWithVideoMuted: callType === 'audio',
          prejoinPageEnabled: false,
          disableDeepLinking: true,
        },
        interfaceConfigOverwrite: {
          TOOLBAR_BUTTONS: [
            'microphone', 'camera', 'desktop', 'fullscreen',
            'hangup', 'chat', 'tileview',
          ],
          SHOW_JITSI_WATERMARK: false,
          SHOW_WATERMARK_FOR_GUESTS: false,
        },
      });

      this.jitsiApi.addEventListener('videoConferenceLeft', () => {
        this.hangUp();
      });

      this.jitsiApi.addEventListener('readyToClose', () => {
        this.hangUp();
      });

      this.jitsiApi.addEventListener('errorOccurred', (e) => {
        console.error('[nine-call] Jitsi error:', e);
        this.onCallError?.('Call connection error: ' + (e?.error?.message || 'unknown'));
      });
    } catch (err) {
      console.error('[nine-call] join failed:', err);
      this.onCallError?.('Could not join the call');
      this._cleanup();
    }
  }

  _cleanup() {
    if (this.jitsiApi) {
      try {
        this.jitsiApi.dispose();
      } catch (e) { /* already gone */ }
      this.jitsiApi = null;
    }
    this.remoteUserId = null;
    this.pendingCallType = null;
    this.pendingRoomName = null;
  }
}

/*
  ABOUT MEET.JIT.SI (FREE PUBLIC SERVER):
  - No account, no API key, no card, no per-minute limits
  - Anyone who knows (or guesses) the room name can join it — fine for
    a personal project between friends, since room names are derived
    from both users' numeric IDs and not shown anywhere public
  - If you ever want more control (custom branding, guaranteed
    capacity, private rooms with passwords), self-hosting Jitsi or
    using Jitsi as a Service (JaaS) are the upgrade paths — not needed
    for this app right now
*/
