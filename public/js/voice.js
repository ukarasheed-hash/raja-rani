/**
 * Raja Rani — voice chat (WebRTC full mesh + push-to-talk floor).
 *
 * Design:
 *  - Every pair of connected players opens one RTCPeerConnection (audio only).
 *  - Signalling rides on Socket.IO ('voice:signal'); the server relays it.
 *  - The server arbitrates the floor: only one speaker at a time.
 *    'Hold to talk' requests the floor; the mic track is enabled only while
 *    the server confirms this client holds it. Host may interrupt; host may
 *    force-mute anyone.
 *  - Microphone permission is requested lazily on the first press of the
 *    talk button, with a clear explanation. Denial disables the button
 *    gracefully (game still works).
 */
'use strict';

const Voice = (() => {
  const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  let socket = null;
  let myId = null;
  let isHost = false;
  let localStream = null;      // mic stream (track disabled unless speaking)
  let micDenied = false;
  let micRequested = false;
  const peers = new Map();     // playerId -> {pc, name}
  const callbacks = {};        // event subscriptions

  function on(evt, fn) { (callbacks[evt] ||= []).push(fn); }
  function emit(evt, data) { (callbacks[evt] || []).forEach((fn) => fn(data)); }

  function init(sock, playerId, host) {
    // socket.io reuses the same socket object across reconnects — don't double-register
    if (socket === sock && myId === playerId) { isHost = host; return; }
    socket = sock; myId = playerId; isHost = host;

    socket.on('voice:peers', ({ peers: list }) => {
      // We are the newcomer: create an offer to every existing peer.
      list.forEach(({ id, name }) => addPeer(id, name, true));
    });
    socket.on('voice:peer-joined', ({ id, name }) => {
      // An existing client learns about the newcomer; the newcomer offers.
      if (id !== myId && !peers.has(id)) addPeer(id, name, false);
    });
    socket.on('voice:peer-left', ({ id }) => removePeer(id));
    socket.on('voice:signal', async ({ from, kind, data }) => {
      const peer = peers.get(from);
      if (!peer) return;
      try {
        if (kind === 'offer') {
          await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          socket.emit('voice:signal', { to: from, kind: 'answer', data: answer });
        } else if (kind === 'answer') {
          await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
        } else if (kind === 'ice') {
          await peer.pc.addIceCandidate(new RTCIceCandidate(data));
        }
      } catch (e) { console.warn('voice signal error', e); }
    });

    socket.on('voice:speaker', ({ playerId, name }) => {
      const speaking = playerId === myId;
      setMicLive(speaking);
      emit('speaker', { playerId, name, me: speaking });
    });
    socket.on('voice:busy', () => emit('busy'));
    socket.on('voice:force-mute', () => {
      setMicLive(false);
      emit('muted-by-host');
    });
  }

  async function addPeer(id, name, createOffer) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    peers.set(id, { pc, name });

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voice:signal', { to: id, kind: 'ice', data: e.candidate });
    };
    // Renegotiate when tracks are added later (mic is granted lazily on
    // first push-to-talk, usually after the initial handshake).
    pc.onnegotiationneeded = async () => {
      if (pc.signalingState !== 'stable') return; // initial offer is sent manually
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('voice:signal', { to: id, kind: 'offer', data: offer });
      } catch (e) { console.warn('voice renegotiation failed', e); }
    };
    pc.ontrack = (e) => {
      // Play the remote voice through a hidden audio element.
      let el = document.getElementById('voice-audio-' + id);
      if (!el) {
        el = document.createElement('audio');
        el.id = 'voice-audio-' + id;
        el.autoplay = true;
        el.playsInline = true;
        document.body.appendChild(el);
      }
      el.srcObject = e.streams[0];
    };

    // Attach our mic track if we already have it.
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => pc.addTrack(t, localStream));
    }

    if (createOffer) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('voice:signal', { to: id, kind: 'offer', data: offer });
      } catch (e) { console.warn('voice offer failed', e); }
    }
  }

  function removePeer(id) {
    const peer = peers.get(id);
    if (peer) { try { peer.pc.close(); } catch { /* noop */ } peers.delete(id); }
    document.getElementById('voice-audio-' + id)?.remove();
  }

  /** Ask for the mic with a clear reason; returns true if granted. */
  async function ensureMic() {
    if (localStream) return true;
    if (micDenied) return false;
    if (micRequested) return false;
    micRequested = true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
      // attach to existing peer connections
      peers.forEach(({ pc }) => {
        localStream.getAudioTracks().forEach((t) => pc.addTrack(t, localStream));
      });
      return true;
    } catch (e) {
      console.warn('mic denied/unavailable', e);
      micDenied = true;
      emit('mic-denied');
      return false;
    } finally {
      micRequested = false;
    }
  }

  function setMicLive(live) {
    if (!localStream) return;
    localStream.getAudioTracks().forEach((t) => { t.enabled = live; });
  }

  /** Push-to-talk press. Returns immediately; floor grant arrives via events. */
  async function pressToTalk() {
    const ok = await ensureMic();
    if (!ok) return;
    socket.emit('voice:request-floor');
  }

  function releaseTalk() {
    socket.emit('voice:release-floor');
    setMicLive(false);
  }

  function mutePlayer(targetId) { socket.emit('voice:mute-player', { targetId }); }
  function isMicDenied() { return micDenied; }

  function teardown() {
    peers.forEach(({ pc }) => { try { pc.close(); } catch { /* noop */ } });
    peers.clear();
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  }

  return { init, on, pressToTalk, releaseTalk, mutePlayer, isMicDenied, teardown };
})();
