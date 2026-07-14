/*
  call.js — voice/video calling using WebRTC, signaled through the
  Socket.IO events set up in the backend's socket.js.

  HOW THIS WORKS:
  - Audio/video never touches your server. This code opens a direct
    peer-to-peer connection between two browsers (RTCPeerConnection).
  - Your Socket.IO server is only a messenger: it passes the "here's
    how to reach me" info (SDP offer/answer + ICE candidates) between
    the two browsers so they can find each other.
  - STUN servers (below) help each browser discover its own public
    address. That's usually enough. Some networks (strict NAT, corporate
    firewalls, some mobile carriers) block direct peer-to-peer entirely —
    for those you need a TURN server, which relays the actual media.
    Free STUN is provided by Google below; TURN is NOT free at scale —
    see the note at the bottom of this file.

  USAGE (wire this up in your main app.js):
    const call = new CallManager(socket);
    call.onIncomingCall = (fromUserId, callType) => { ...show incoming UI... };
    call.onRemoteStream = (stream) => { remoteVideoEl.srcObject = stream; };
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
  constructor(socket) {
    this.socket = socket;
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

    this._bindSocketEvents();
  }

  _bindSocketEvents() {
    this.socket.on('call:incoming', ({ fromUserId, callType }) => {
      this.remoteUserId = fromUserId;
      this.pendingCallType = callType;
      this.onIncomingCall?.(fromUserId, callType);
    });

    this.socket.on('call:accepted', async ({ fromUserId }) => {
      // We were the caller; the other side accepted. Create the offer now.
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
          console.warn('Error adding ICE candidate', err);
        }
      }
    });
  }

  // ---- Caller side ----
  async startCall(toUserId, callType = 'video') {
    this.remoteUserId = toUserId;
    this.pendingCallType = callType;
    this.socket.emit('call:invite', { toUserId, callType });
    // Actual offer is created once the callee accepts — see call:accepted above
  }

  // ---- Callee side ----
  async acceptCall() {
    this.socket.emit('call:accept', { toUserId: this.remoteUserId });
    await this._setupPeerConnection(this.remoteUserId);
    // We wait for the caller's offer to arrive via call:signal
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
  async _setupPeerConnection(remoteUserId) {
    this.remoteUserId = remoteUserId;

    this.peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        // Add a TURN server here for reliability across strict networks:
        // { urls: 'turn:your-turn-server.com:3478', username: '...', credential: '...' },
      ],
    });

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('call:signal', {
          toUserId: this.remoteUserId,
          data: event.candidate,
        });
      }
    };

    this.peerConnection.ontrack = (event) => {
      this.onRemoteStream?.(event.streams[0]);
    };

    const constraints = this.pendingCallType === 'audio'
      ? { audio: true, video: false }
      : { audio: true, video: true };

    this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    this.onLocalStream?.(this.localStream);
    this.localStream.getTracks().forEach(track => {
      this.peerConnection.addTrack(track, this.localStream);
    });
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
  ABOUT TURN SERVERS (only needed once you notice calls failing to
  connect for some pairs of users):
  STUN (used above, free) only helps when at least one side has a
  reachable public address. When both users are behind strict NAT/
  firewalls, the browsers can't reach each other directly at all, and
  you need a TURN server to relay the media through. Options:
  - Run your own with coturn (open source) on a small VPS
  - Use a hosted service (Twilio, Metered, Xirsys all have free/cheap tiers)
  You only need this once real usage shows connection failures — don't
  build it before you need it.
*/
