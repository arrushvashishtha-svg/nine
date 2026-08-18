/*
  call.js — voice/video calling using raw WebRTC + free public STUN.

  HOW THIS WORKS:
  This uses the browser's native WebRTC APIs directly (RTCPeerConnection,
  getUserMedia) — no third-party calling platform, no API key, no
  account with any company, nothing that can be rate-limited or change
  behavior on you. Audio/video travels directly between the two
  browsers whenever possible. Socket.IO only relays the initial
  handshake (SDP offers/answers, ICE candidates) so the two browsers can
  find each other, then gets out of the way entirely — your server
  never sees or touches the actual call media.

  Uses Google's free public STUN server to help two browsers discover
  their public IP/port so they can connect directly. This works for the
  large majority of home/mobile networks. It does NOT include a TURN
  relay, which means calls between two people both behind unusually
  strict/symmetric NATs (common on some corporate/school networks, rare
  on home WiFi or cellular) may fail to connect directly. If that ever
  becomes a real problem, a free-tier TURN relay (e.g. Cloudflare
  Calls or Metered.ca both have permanent free tiers) can be added
  later without changing anything else about how this file works.

  USAGE (wire this up in your main app.js):
    const call = new CallManager(socket, API_BASE, state.token);
    call.onIncomingCall = (fromUserId, callType) => { ...show incoming UI... };
    call.onRemoteStream = (stream) => { remoteVideoEl.srcObject = stream; };
    call.onLocalStream = (stream) => { localVideoEl.srcObject = stream; };
    call.onCallEnded = () => { ...hide call UI... };

    // to start a call:
    await call.startCall(friendUserId, 'video'); // or 'audio'

    // to accept an incoming call:
    await call.acceptCall();

    // to decline/hang up:
    call.declineCall();
    call.hangUp();
*/

const FREE_STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

class CallManager {
  constructor(socket, apiBase, authToken) {
    this.socket = socket;
    this.apiBase = apiBase;
    this.authToken = authToken;
    this.peerConnection = null;
    this.localStream = null;
    this.remoteUserId = null;
    this.pendingCallType = null;

    // Callbacks — set these from your UI code
    this.onIncomingCall = null;   // (fromUserId, callType) => {}
    this.onRemoteStream = null;   // (MediaStream) => {}
    this.onLocalStream = null;    // (MediaStream) => {}
    this.onCallEnded = null;      // () => {}
    this.onCallDeclined = null;   // () => {}
    this.onCallUnavailable = null;// () => {} — friend is offline
    this.onCallError = null;      // (message) => {} — mic/camera or connection failure

    this._bindSocketEvents();
  }

  _bindSocketEvents() {
    this.socket.on('call:incoming', ({ fromUserId, callType }) => {
      this.remoteUserId = fromUserId;
      this.pendingCallType = callType;
      this.onIncomingCall?.(fromUserId, callType);
    });

    this.socket.on('call:accepted', async ({ fromUserId }) => {
      // We're the caller; the other side accepted. Create the offer now.
      await this._createOfferAndSend(fromUserId);
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

    this.socket.on('call:signal', async ({ fromUserId, data }) => {
      if (!this.peerConnection) {
        // We're the callee receiving the first offer — set up our side now.
        await this._setupPeerConnection(fromUserId);
      }
      if (data.type === 'offer') {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        this.socket.emit('call:signal', { toUserId: fromUserId, data: answer });
      } else if (data.type === 'answer') {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data));
      } else if (data.candidate) {
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(data));
        } catch (err) {
          console.warn('[nine-call] error adding ICE candidate', err);
        }
      }
    });
  }

  // ---- Caller side ----
  async startCall(toUserId, callType = 'video') {
    console.log('[nine-call] starting call to', toUserId, callType);
    this.remoteUserId = toUserId;
    this.pendingCallType = callType;
    this.socket.emit('call:invite', { toUserId, callType });
  }

  // ---- Callee side ----
  async acceptCall() {
    this.socket.emit('call:accept', { toUserId: this.remoteUserId });
    await this._setupPeerConnection(this.remoteUserId);
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

  // Checks what devices are actually available before asking the browser
  // to grab one — gives a clear "no mic found" message instead of a
  // cryptic device error deep inside getUserMedia.
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

  async _setupPeerConnection(remoteUserId) {
    this.remoteUserId = remoteUserId;
    console.log('[nine-call] setting up peer connection with', remoteUserId);

    const { hasMic, hasCam } = await this._checkDevices();
    if (!hasMic) {
      this.onCallError?.('No microphone found on this device. Connect a mic and try again.');
      this._cleanup();
      throw new Error('No microphone found');
    }

    this.peerConnection = new RTCPeerConnection({ iceServers: FREE_STUN_SERVERS });

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('call:signal', {
          toUserId: this.remoteUserId,
          data: event.candidate,
        });
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      console.log('[nine-call] ICE state:', this.peerConnection.iceConnectionState);
      if (this.peerConnection.iceConnectionState === 'failed') {
        this.onCallError?.('Could not connect — this can happen on some networks (e.g. corporate/school WiFi). Try a different network.');
      }
    };

    this.peerConnection.ontrack = (event) => {
      console.log('[nine-call] remote track received');
      this.onRemoteStream?.(event.streams[0]);
    };

    const wantsVideo = this.pendingCallType !== 'audio';
    const constraints = { audio: true, video: wantsVideo && hasCam };
    if (wantsVideo && !hasCam) {
      console.warn('[nine-call] no camera found — continuing as audio-only');
    }

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.error('[nine-call] getUserMedia failed:', err.name, err.message);
      this.onCallError?.(
        err.name === 'NotAllowedError' ? 'Camera/mic permission was denied'
        : err.name === 'NotFoundError' ? 'No camera/mic found on this device'
        : 'Could not access camera/mic: ' + err.message
      );
      this._cleanup();
      throw err;
    }
    this.onLocalStream?.(this.localStream);
    this.localStream.getTracks().forEach(track => {
      this.peerConnection.addTrack(track, this.localStream);
    });
  }

  // Swaps the video track currently being sent to the other person for
  // a new one (e.g. a canvas-filtered version) without tearing down or
  // renegotiating the peer connection. Used for the video filter
  // feature — the filtered canvas output replaces the raw camera feed
  // as what actually gets sent, so both people see the effect, not
  // just the local self-view.
  replaceOutgoingVideoTrack(newTrack) {
    if (!this.peerConnection || !newTrack) return;
    const sender = this.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) {
      sender.replaceTrack(newTrack).catch(err => {
        console.warn('[nine-call] replaceTrack failed:', err);
      });
    }
  }

  async _createOfferAndSend(toUserId) {
    await this._setupPeerConnection(toUserId);
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    this.socket.emit('call:signal', { toUserId, data: offer });
  }

  _cleanup() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    this.remoteUserId = null;
    this.pendingCallType = null;
  }
}

/*
  ABOUT THIS SETUP:
  - Completely free, forever — no account, no API key, no company's
    server in the middle, nothing that can rate-limit or change on you
  - Uses Google's free public STUN server just to help two browsers find
    each other's network address; the actual call audio/video goes
    directly between the two people, never through any server
  - Works for the large majority of networks (home WiFi, cellular,
    most public WiFi). Rare strict/corporate networks may be unable to
    connect directly — if that ever comes up, adding a free TURN relay
    (Cloudflare Calls or Metered.ca both have permanent free tiers) is
    a small addition later, nothing else about this file would need to
    change.
*/
