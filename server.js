/**
 * Raja Rani (കള്ളൻ പോലീസ്) — game server.
 * Node.js + Express + Socket.IO. No database: rooms live in memory.
 *
 * ROOM LIFECYCLE
 *   lobby → (host: start-round) → dealt → (police declares) → police
 *         → (police guesses) → reveal → (host: next-round) → dealt ...
 *   Any phase: request-end → vote → game-ended → (host: play-again) → lobby
 *
 * VOICE
 *   Full-mesh WebRTC audio. This server only relays signalling
 *   (voice:signal) and arbitrates the push-to-talk floor
 *   (one speaker at a time; host may interrupt and may mute anyone).
 */
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // generous but sane payload limits; signalling messages are tiny
  maxHttpBufferSize: 1e6,
});

app.use(express.static(path.join(__dirname, 'public')));
// Deep-link support: /r/ABC123 serves the app; client reads the code from the URL.
app.get('/r/:code', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ */
/* Game configuration — edit roles/points here.                        */
/* ------------------------------------------------------------------ */
const ROLE_POINTS = {
  king: 1000,
  queen: 800,
  prince: 700,
  princess: 700,
  minister: 600,
  soldier: 500,
  police: 500, // shown as hidden until the round resolves
  thief: 0,    // shown as hidden until the round resolves
};

// Default card names. The host may override en/ml per room (points are fixed).
const DEFAULT_CARD_NAMES = {
  king:     { en: 'King',     ml: '' },
  queen:    { en: 'Queen',    ml: '' },
  prince:   { en: 'Prince',   ml: '' },
  princess: { en: 'Princess', ml: '' },
  minister: { en: 'Minister', ml: '' },
  soldier:  { en: 'Soldier',  ml: '' },
  police:   { en: 'Police',   ml: '' },
  thief:    { en: 'Thief',    ml: '' },
};

const MIN_PLAYERS = 5;
const END_VOTES_NEEDED = 4;

/** Roles dealt for a given player count. Exactly one police + one thief. */
function rolesForCount(n) {
  const roles = ['king', 'queen', 'minister', 'police', 'thief'];
  if (n >= 6) roles.push('prince');
  if (n >= 7) roles.push('princess');
  while (roles.length < n) roles.push('soldier');
  return roles;
}

/* ------------------------------------------------------------------ */
/* In-memory state                                                    */
/* ------------------------------------------------------------------ */
// rooms: code -> room
// room = {
//   code, hostId, phase, round,
//   players: Map<playerId, {id,name,socketId,connected,score,role,flipped}>,
//   cardNames: {role:{en,ml}},
//   policeId: string|null,          // set once police declares
//   endVotes: Set<playerId>,
//   speakerId: string|null,         // voice floor
// }
const rooms = new Map();
// socket.id -> {code, playerId} for quick lookup on disconnect
const socketMeta = new Map();

function makeCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Public snapshot of a room — never includes other players' secret roles. */
function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    hostId: room.hostId,
    cardNames: room.cardNames,
    policeId: room.policeId,
    endVotesNeeded: END_VOTES_NEEDED,
    endVotes: [...room.endVotes].map((id) => room.players.get(id)?.name).filter(Boolean),
    speaker: room.speakerId
      ? { id: room.speakerId, name: room.players.get(room.speakerId)?.name }
      : null,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      score: p.score,
      hasCard: !!p.role,
      flipped: p.flipped,
      isHost: p.id === room.hostId,
    })),
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room-state', publicRoom(room));
}

function getPlayerBySocket(socket) {
  const meta = socketMeta.get(socket.id);
  if (!meta) return null;
  const room = rooms.get(meta.code);
  if (!room) return null;
  const player = room.players.get(meta.playerId);
  if (!player) return null;
  return { room, player };
}

/* ------------------------------------------------------------------ */
/* Socket.IO                                                          */
/* ------------------------------------------------------------------ */
io.on('connection', (socket) => {
  /* ---------------- rooms & lobby ---------------- */

  socket.on('create-room', ({ name }) => {
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) return socket.emit('join-error', { message: 'Please enter a display name.' });
    const code = makeCode();
    const playerId = makeId();
    const room = {
      code,
      hostId: playerId,
      phase: 'lobby',
      round: 0,
      players: new Map(),
      cardNames: JSON.parse(JSON.stringify(DEFAULT_CARD_NAMES)),
      policeId: null,
      endVotes: new Set(),
      speakerId: null,
    };
    room.players.set(playerId, {
      id: playerId, name: clean, socketId: socket.id,
      connected: true, score: 0, role: null, flipped: false,
    });
    rooms.set(code, room);
    socket.join(code);
    socketMeta.set(socket.id, { code, playerId });
    socket.emit('room-created', {
      code,
      player: { id: playerId, name: clean, isHost: true },
    });
    broadcastRoom(room);
    // voice peer list for the creator (empty for now)
    socket.emit('voice:peers', { peers: [] });
  });

  socket.on('join-room', ({ code, name, playerId }) => {
    code = String(code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit('join-error', { message: 'Room not found. Check the code and try again.' });

    // Rejoin with a known player id (keeps score across disconnects)
    if (playerId && room.players.has(playerId)) {
      const player = room.players.get(playerId);
      // drop any stale socket still mapped to this player
      if (player.socketId && player.socketId !== socket.id) {
        socketMeta.delete(player.socketId);
      }
      player.socketId = socket.id;
      player.connected = true;
      socket.join(code);
      socketMeta.set(socket.id, { code, playerId });
      socket.emit('room-joined', { room: publicRoom(room), you: { id: player.id, name: player.name, isHost: player.id === room.hostId } });
      if (player.role) socket.emit('your-card', { role: player.role }); // restore secret card
      socket.to(code).emit('player-event', { type: 'rejoined', player: { id: player.id, name: player.name } });
      sendVoicePeers(socket, room, player);
      broadcastRoom(room);
      return;
    }

    if (room.phase !== 'lobby') {
      return socket.emit('join-error', { message: 'This room already started playing. Ask the host to finish the round first.' });
    }
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) return socket.emit('join-error', { message: 'Please enter a display name.' });
    const taken = [...room.players.values()].some(
      (p) => p.name.toLowerCase() === clean.toLowerCase()
    );
    if (taken) return socket.emit('join-error', { message: `The name "${clean}" is already taken in this room.` });

    const newId = makeId();
    room.players.set(newId, {
      id: newId, name: clean, socketId: socket.id,
      connected: true, score: 0, role: null, flipped: false,
    });
    socket.join(code);
    socketMeta.set(socket.id, { code, playerId: newId });
    socket.emit('room-joined', {
      room: publicRoom(room),
      you: { id: newId, name: clean, isHost: false },
    });
    socket.to(code).emit('player-event', { type: 'joined', player: { id: newId, name: clean } });
    sendVoicePeers(socket, room, room.players.get(newId));
    broadcastRoom(room);
  });

  // Editable display name — lobby only, locked once play starts.
  socket.on('update-name', ({ name }) => {
    const found = getPlayerBySocket(socket);
    if (!found) return;
    const { room, player } = found;
    if (room.phase !== 'lobby') {
      return socket.emit('error-msg', { message: 'Names are locked once the game starts.' });
    }
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) return socket.emit('error-msg', { message: 'Name cannot be empty.' });
    const taken = [...room.players.values()].some(
      (p) => p.id !== player.id && p.name.toLowerCase() === clean.toLowerCase()
    );
    if (taken) return socket.emit('error-msg', { message: `The name "${clean}" is already taken.` });
    player.name = clean;
    broadcastRoom(room);
  });

  // Host-only card name customization (lobby only).
  socket.on('customize-cards', ({ names }) => {
    const found = getPlayerBySocket(socket);
    if (!found) return;
    const { room, player } = found;
    if (player.id !== room.hostId) return socket.emit('error-msg', { message: 'Only the host can customize cards.' });
    if (room.phase !== 'lobby') return socket.emit('error-msg', { message: 'Cards can only be customized in the lobby.' });
    for (const role of Object.keys(DEFAULT_CARD_NAMES)) {
      const entry = names && names[role];
      if (!entry) continue;
      const en = String(entry.en || '').trim().slice(0, 24);
      const ml = String(entry.ml || '').trim().slice(0, 24);
      room.cardNames[role] = { en: en || DEFAULT_CARD_NAMES[role].en, ml };
    }
    io.to(room.code).emit('card-names-updated', { names: room.cardNames });
    broadcastRoom(room);
  });

  socket.on('reset-cards', () => {
    const found = getPlayerBySocket(socket);
    if (!found) return;
    const { room, player } = found;
    if (player.id !== room.hostId) return socket.emit('error-msg', { message: 'Only the host can reset cards.' });
    if (room.phase !== 'lobby') return socket.emit('error-msg', { message: 'Cards can only be reset in the lobby.' });
    room.cardNames = JSON.parse(JSON.stringify(DEFAULT_CARD_NAMES));
    io.to(room.code).emit('card-names-updated', { names: room.cardNames });
    broadcastRoom(room);
  });

  /* ---------------- rounds ---------------- */

  socket.on('start-round', () => {
    const found = getPlayerBySocket(socket);
    if (!found) return;
    const { room, player } = found;
    if (player.id !== room.hostId) return socket.emit('error-msg', { message: 'Only the host can start the round.' });
    if (room.phase !== 'lobby' && room.phase !== 'reveal') {
      return socket.emit('error-msg', { message: 'A round is already in progress.' });
    }
    const active = [...room.players.values()].filter((p) => p.connected);
    if (active.length < MIN_PLAYERS) {
      return socket.emit('error-msg', { message: `Need at least ${MIN_PLAYERS} players to start (have ${active.length}).` });
    }
    dealRound(room);
  });

  function dealRound(room) {
    const active = [...room.players.values()].filter((p) => p.connected);
    const roles = rolesForCount(active.length);
    // Fisher–Yates shuffle
    for (let i = roles.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }
    room.round += 1;
    room.phase = 'dealt';
    room.policeId = null;
    room.endVotes.clear();
    active.forEach((p, i) => {
      p.role = roles[i];
      p.flipped = false;
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit('your-card', { role: p.role });
    });
    // disconnected players keep old state; they get their card on rejoin
    io.to(room.code).emit('round-dealt', { round: room.round });
    broadcastRoom(room);
  }

  socket.on('declare-police', () => {
    const found = getPlayerBySocket(socket);
    if (!found) return;
    const { room, player } = found;
    if (room.phase !== 'dealt') return;
    if (player.role !== 'police') {
      return socket.emit('error-msg', { message: 'Only the real Police can declare.' });
    }
    room.phase = 'police';
    room.policeId = player.id;
    io.to(room.code).emit('police-declared', { playerId: player.id, name: player.name });
    broadcastRoom(room);
  });

  socket.on('guess-thief', ({ targetId }) => {
    const found = getPlayerBySocket(socket);
    if (!found) return;
    const { room, player } = found;
    if (room.phase !== 'police') return;
    if (player.id !== room.policeId) {
      return socket.emit('error-msg', { message: 'Only the Police picks the thief.' });
    }
    const target = room.players.get(targetId);
    if (!target || !target.connected) return socket.emit('error-msg', { message: 'Pick a player at the table.' });
    if (targetId === player.id) return socket.emit('error-msg', { message: 'The Police cannot accuse themselves.' });

    const thiefEntry = [...room.players.values()].find((p) => p.role === 'thief');
    const correct = target.role === 'thief';

    // Scoring
    const roundPoints = {};
    for (const p of room.players.values()) {
      if (!p.connected || !p.role) { roundPoints[p.id] = 0; continue; }
      let pts;
      if (p.role === 'police') pts = correct ? ROLE_POINTS.police : 0;
      else if (p.role === 'thief') pts = correct ? 0 : ROLE_POINTS.police; // thief steals the 500 on a wrong guess
      else pts = ROLE_POINTS[p.role];
      roundPoints[p.id] = pts;
      p.score += pts;
    }
    room.phase = 'reveal';
    const roles = {};
    for (const p of room.players.values()) roles[p.id] = p.role;
    io.to(room.code).emit('round-result', {
      correct,
      policeId: player.id,
      policeName: player.name,
      accusedId: targetId,
      accusedName: target.name,
      thiefId: thiefEntry ? thiefEntry.id : null,
      thiefName: thiefEntry ? thiefEntry.name : '',
      roundPoints,
      roles,
      totals: totalsOf(room),
      cardNames: room.cardNames,
    });
    broadcastRoom(room);
  });

  socket.on('next-round', () => {
    const found = getPlayerBySocket(socket);
    if (!found) return;
    const { room, player } = found;
    if (player.id !== room.hostId) return socket.emit('error-msg', { message: 'Only the host starts the next round.' });
    if (room.phase !== 'reveal') return socket.emit('error-msg', { message: 'Finish the current round first.' });
    dealRound(room);
  });

  /* ---------------- end of game ---------------- */

  socket.on('request-end', () => {
    const found = getPlayerBySocket(socket);
    if (!found) return;
    const { room, player } = found;
    if (room.phase === 'ended' || room.phase === 'lobby') {
      return socket.emit('error-msg', { message: 'There is no active game to end.' });
    }
    room.endVotes.clear();
    room.endVotes.add(player.id);
    io.to(room.code).emit('end-vote', {
      requesterName: player.name,
      approvals: [...room.endVotes].length,
      needed: END_VOTES_NEEDED,
    });
    checkEndVotes(room);
  });

  socket.on('approve-end', () => {
    const found = getPlayerBySocket(socket);
    if (!found) return;
    const { room, player } = found;
    if (room.endVotes.size === 0) return; // no vote in progress
    room.endVotes.add(player.id);
    io.to(room.code).emit('end-vote', {
      approvals: [...room.endVotes].length,
      needed: END_VOTES_NEEDED,
    });
    checkEndVotes(room);
  });

  function checkEndVotes(room) {
    if (room.endVotes.size >= END_VOTES_NEEDED) {
      room.phase = 'ended';
      room.endVotes.clear();
      io.to(room.code).emit('game-ended', { totals: totalsOf(room) });
      broadcastRoom(room);
    }
  }

  socket.on('play-again', () => {
    const found = getPlayerBySocket(socket);
    if (!found) return;
    const { room, player } = found;
    if (player.id !== room.hostId) return socket.emit('error-msg', { message: 'Only the host can start a new game.' });
    for (const p of room.players.values()) {
      p.score = 0; p.role = null; p.flipped = false;
    }
    room.round = 0;
    room.phase = 'lobby';
    room.policeId = null;
    room.endVotes.clear();
    io.to(room.code).emit('play-again');
    broadcastRoom(room);
  });

  /* ---------------- voice chat ---------------- */
  // Floor arbitration: one speaker at a time; host may interrupt.

  socket.on('voice:request-floor', () => {
    const found = getPlayerBySocket(socket);
    if (!found) return;
    const { room, player } = found;
    if (!room.speakerId) {
      room.speakerId = player.id;
      io.to(room.code).emit('voice:speaker', { playerId: player.id, name: player.name });
    } else if (room.speakerId === player.id) {
      socket.emit('voice:speaker', { playerId: player.id, name: player.name }); // reaffirm
    } else if (player.id === room.hostId) {
      // Host interrupts whoever is speaking.
      room.speakerId = player.id;
      io.to(room.code).emit('voice:speaker', { playerId: player.id, name: player.name });
    } else {
      socket.emit('voice:busy');
    }
  });

  socket.on('voice:release-floor', () => {
    const found = getPlayerBySocket(socket);
    if (!found) return;
    const { room, player } = found;
    if (room.speakerId === player.id) {
      room.speakerId = null;
      io.to(room.code).emit('voice:speaker', { playerId: null, name: null });
    }
  });

  socket.on('voice:mute-player', ({ targetId }) => {
    const found = getPlayerBySocket(socket);
    if (!found) return;
    const { room, player } = found;
    if (player.id !== room.hostId) return socket.emit('error-msg', { message: 'Only the host can mute players.' });
    const target = room.players.get(targetId);
    if (!target) return;
    const s = io.sockets.sockets.get(target.socketId);
    if (s) s.emit('voice:force-mute');
    if (room.speakerId === targetId) {
      room.speakerId = null;
      io.to(room.code).emit('voice:speaker', { playerId: null, name: null });
    }
    socket.to(room.code).emit('player-event', { type: 'muted', player: { id: targetId, name: target.name } });
  });

  // WebRTC signalling relay (offer / answer / ICE).
  socket.on('voice:signal', ({ to, kind, data }) => {
    const found = getPlayerBySocket(socket);
    if (!found) return;
    const { room, player } = found;
    const target = room.players.get(to);
    if (!target) return;
    const s = io.sockets.sockets.get(target.socketId);
    if (s) s.emit('voice:signal', { from: player.id, kind, data });
  });

  /* ---------------- disconnect ---------------- */

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    socketMeta.delete(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.code);
    if (!room) return;
    const player = room.players.get(meta.playerId);
    if (!player) return;
    player.connected = false;
    player.socketId = null;
    // free the voice floor if they were speaking
    if (room.speakerId === player.id) {
      room.speakerId = null;
      io.to(room.code).emit('voice:speaker', { playerId: null, name: null });
    }
    socket.to(room.code).emit('player-event', { type: 'left', player: { id: player.id, name: player.name } });
    socket.to(room.code).emit('voice:peer-left', { id: player.id });
    broadcastRoom(room);
    // tidy up empty rooms (all players gone)
    const anyone = [...room.players.values()].some((p) => p.connected);
    if (!anyone) rooms.delete(room.code);
  });
});

/** Send peer list to a joiner and announce them to existing peers. */
function sendVoicePeers(socket, room, player) {
  const peers = [...room.players.values()]
    .filter((p) => p.connected && p.id !== player.id && p.socketId)
    .map((p) => ({ id: p.id, name: p.name }));
  socket.emit('voice:peers', { peers });
  socket.to(room.code).emit('voice:peer-joined', { id: player.id, name: player.name });
}

function totalsOf(room) {
  return [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected }))
    .sort((a, b) => b.score - a.score);
}

server.listen(PORT, () => {
  console.log(`Raja Rani server listening on http://localhost:${PORT}`);
});
