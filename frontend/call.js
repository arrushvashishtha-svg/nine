/*
  call.js — voice/video calling using Agora.

  HOW THIS WORKS:
  Agora's SDK handles the entire WebRTC layer for you — routing, media,
  and their global network — so you don't manage peer connections or
  ICE candidates directly. Instead, both participants join the same
  named "channel" using a short-lived token from your backend.

  Flow:
  1. Caller and callee agree on a channel name (deterministic: built
     from both user IDs sorted, so both sides compute the same string)
  2. Caller sends a ring ('call:invite') with that channel name via
     Socket.IO
  3. Callee accepts -> both sides ask the backend for a token
     (POST /calls/token) and call Agora's join() with that token
  4. Agora's SDK publishes local audio/video and delivers the other
     person's stream via the 'user-published' event

  Requires the Agora Web SDK loaded on the page:
    <script src="https://download.agora.io/sdk/release/AgoraRTC_N-4.20.0.js"></script>

  USAGE (wire this up in your main app.js):
    const call = new CallManager(socket, API_BASE, state.token, myUserId);
    call.onIncomingCall = (fromUserId, callType) => { ...show incoming UI... };
    call.onRemoteStream = (stream) => { remoteVideoEl.srcObject/attach... };
    call.onLocalStream = (stream) => { localVideoEl attach... };
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
    this.client = null;
    this.localAudioTrack = null;
    this.localVideoTrack = null;
    this.remoteUserId = null;
    this.pendingCallType = null;
    this.pendingChannelName = null;

    // Callbacks — set these from your UI code
    this.onIncomingCall = null;   // (fromUserId, callType) => {}
    this.onRemoteVideoTrack = null; // (track) => {} — call track.play(el) yourself
    this.onLocalVideoTrack = null;  // (track) => {}
    this.onCallEnded = null;      // () => {}
    this.onCallDeclined = null;   // () => {}
    this.onCallUnavailable = null;// () => {} — friend is offline
    this.onCallError = null;      // (message) => {}

    this._bindSocketEvents();
  }

  _channelNameFor(otherUserId) {
    // Deterministic, so both sides independently compute the identical
    // channel name without needing to pass it back and forth first.
    const ids = [this.myUserId, otherUserId].sort((a, b) => a - b);
    return `nine-${ids[0]}-${ids[1]}`;
  }

  _bindSocketEvents() {
    this.socket.on('call:incoming', ({ fromUserId, callType, channelName }) => {
      this.remoteUserId = fromUserId;
      this.pendingCallType = callType;
      this.pendingChannelName = channelName;
      this.onIncomingCall?.(fromUserId, callType);
    });

    this.socket.on('call:accepted', async () => {
      // We're the caller; the other side accepted — join the channel now.
      await this._joinChannel(this.pendingChannelName, this.pendingCallType);
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
    this.pendingChannelName = this._channelNameFor(toUserId);
    this.socket.emit('call:invite', { toUserId, callType, channelName: this.pendingChannelName });
  }

  // ---- Callee side ----
  async acceptCall() {
    this.socket.emit('call:accept', { toUserId: this.remoteUserId });
    await this._joinChannel(this.pendingChannelName, this.pendingCallType);
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
  async _getToken(channelName) {
    const res = await fetch(`${this.apiBase}/calls/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`,
      },
      body: JSON.stringify({ channelName }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not get a call token');
    return data;
  }

  // Checks what devices are actually available before we ask Agora to
  // grab one. Browsers/OSes report "no device" in two different ways:
  // either enumerateDevices() simply lists none, or the device exists
  // but is blocked/busy and getUserMedia-style calls throw instead.
  // We only trust enumerateDevices() here as a pre-check; Agora's own
  // create*Track() calls are still wrapped in try/catch below as the
  // final source of truth.
  async _checkDevices() {
    let hasMic = false;
    let hasCam = false;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      hasMic = devices.some(d => d.kind === 'audioinput');
      hasCam = devices.some(d => d.kind === 'videoinput');
    } catch (err) {
      console.warn('[nine-call] could not enumerate devices, assuming both exist', err);
      hasMic = true;
      hasCam = true;
    }
    return { hasMic, hasCam };
  }

  async _joinChannel(channelName, callType) {
    if (!window.AgoraRTC) {
      console.error('[nine-call] Agora SDK not loaded');
      this.onCallError?.('Calling library did not load — check your connection and try again');
      return;
    }

    console.log('[nine-call] joining channel', channelName);

    const { hasMic, hasCam } = await this._checkDevices();

    if (!hasMic) {
      // A call with no mic and no camera isn't a call — bail before we
      // ever touch Agora, with a message that actually explains why.
      this.onCallError?.('No microphone found on this device. Connect a mic and try again.');
      return;
    }

    const wantsVideo = callType !== 'audio';
    const willPublishVideo = wantsVideo && hasCam;
    if (wantsVideo && !hasCam) {
      console.warn('[nine-call] no camera found — continuing as audio-only');
    }

    try {
      const { token, appId, uid } = await this._getToken(channelName);

      this.client = window.AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });

      this.client.on('user-published', async (user, mediaType) => {
        await this.client.subscribe(user, mediaType);
        if (mediaType === 'video') {
          this.onRemoteVideoTrack?.(user.videoTrack);
        }
        if (mediaType === 'audio') {
          user.audioTrack.play();
        }
      });

      this.client.on('user-left', () => {
        this.hangUp();
      });

      await this.client.join(appId, channelName, token, uid);

      // Mic is required and already confirmed present above, but the OS
      // can still refuse it (permission denied, in use elsewhere, etc.)
      // — that's a real failure Agora needs to throw, so no fallback here.
      try {
        this.localAudioTrack = await window.AgoraRTC.createMicrophoneAudioTrack();
      } catch (err) {
        console.error('[nine-call] microphone track failed:', err);
        throw new Error(
          err.name === 'NotAllowedError' || /Permission/i.test(err.message || '')
            ? 'Microphone permission was denied'
            : 'Could not access your microphone: ' + (err.message || 'unknown error')
        );
      }
      const tracksToPublish = [this.localAudioTrack];

      if (willPublishVideo) {
        try {
          this.localVideoTrack = await window.AgoraRTC.createCameraVideoTrack();
          this.onLocalVideoTrack?.(this.localVideoTrack);
          tracksToPublish.push(this.localVideoTrack);
        } catch (err) {
          // Camera failed even though enumerateDevices saw one (permission
          // denied, camera in use, etc). Don't kill the whole call — drop
          // to audio-only instead, same as when no camera exists at all.
          console.warn('[nine-call] camera track failed, continuing audio-only:', err);
          this.onCallError?.('Camera unavailable — continuing with audio only.');
        }
      }

      await this.client.publish(tracksToPublish);
    } catch (err) {
      console.error('[nine-call] join failed:', err);
      this.onCallError?.(
        (err.name === 'NotAllowedError' || /Permission/i.test(err.message || ''))
          ? 'Camera/mic permission was denied'
          : (err.message || 'Could not join the call')
      );
      this._cleanup();
    }
  }

  _cleanup() {
    if (this.localAudioTrack) {
      this.localAudioTrack.close();
      this.localAudioTrack = null;
    }
    if (this.localVideoTrack) {
      this.localVideoTrack.close();
      this.localVideoTrack = null;
    }
    if (this.client) {
      try { this.client.leave(); } catch (e) { /* already left */ }
      this.client = null;
    }
    this.remoteUserId = null;
    this.pendingCallType = null;
    this.pendingChannelName = null;
  }
}

/*
  ABOUT AGORA'S FREE TIER:
  - No credit card required to sign up or use the free tier
  - 10,000 free minutes per month, shared across all projects on the account
  - If you outgrow this, Agora's pay-as-you-go rates kick in automatically
    only once you exceed the free allowance
*/
