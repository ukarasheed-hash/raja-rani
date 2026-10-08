/**
 * Raja Rani — game client.
 * Single-page app: home → lobby → game table → reveal → final.
 * All server messages are handled below; the protocol mirrors server.js.
 */
'use strict';

/* ---------------- constants ---------------- */
const ROLE_UI = {
  king:     { icon: '👑', points: 1000 },
  queen:    { icon: '👸', points: 800 },
  prince:   { icon: '🤴', points: 700 },
  princess: { icon: '👰', points: 700 },
  minister: { icon: '🎩', points: 600 },
  soldier:  { icon: '💂', points: 500 },
  police:   { icon: '👮', points: 500, hidden: true },
  thief:    { icon: '🥷', points: 0, hidden: true },
};
const ROLE_LIST = ['king', 'queen', 'prince', 'princess', 'minister', 'soldier', 'police', 'thief'];

/* ---------------- state ---------------- */
const S = {
  socket: null,
  code: null,
  me: { id: null, name: '', isHost: false },
  room: null,          // public room snapshot from server
  cardNames: null,     // {role:{en,ml}}
  myRole: null,        // secret — only this client knows
  myFlipped: false,
  voted: false,
};

const $ = (id) => document.getElementById(id);

/* ---------------- helpers ---------------- */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $('screen-' + id).classList.add('active');
  window.scrollTo(0, 0);
}

function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, {
    position: 'fixed', left: '50%', bottom: '90px', transform: 'translateX(-50%)',
    background: 'rgba(20,6,36,.95)', border: '1px solid rgba(255,209,102,.5)',
    padding: '10px 18px', borderRadius: '999px', zIndex: 80, fontWeight: 700,
    maxWidth: '90vw', textAlign: 'center',
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/** Display name for a role: Malayalam large + English small, or English only. */
function roleNameHTML(role) {
  const n = (S.cardNames && S.cardNames[role]) || { en: role, ml: '' };
  if (n.ml) {
    return `<div class="role-name-ml ml-font">${escapeHTML(n.ml)}</div>` +
           `<div class="role-name-en">${escapeHTML(n.en)}</div>`;
  }
  return `<div class="role-name-ml">${escapeHTML(n.en)}</div>`;
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- confetti ---------------- */
const Confetti = (() => {
  const canvas = $('confetti');
  const ctx = canvas.getContext('2d');
  let parts = [], raf = null;
  function resize() { canvas.width = innerWidth; canvas.height = innerHeight; }
  addEventListener('resize', resize); resize();
  function burst(n = 160) {
    const colors = ['#ffd166', '#ff4d5e', '#4da6ff', '#b388ff', '#7CFC00', '#ff9de2'];
    for (let i = 0; i < n; i++) {
      parts.push({
        x: Math.random() * canvas.width, y: -20 - Math.random() * canvas.height * 0.3,
        w: 6 + Math.random() * 8, h: 8 + Math.random() * 10,
        c: colors[(Math.random() * colors.length) | 0],
        vy: 2 + Math.random() * 3.5, vx: -1.5 + Math.random() * 3,
        r: Math.random() * Math.PI, vr: -0.1 + Math.random() * 0.2,
      });
    }
    if (!raf) loop();
  }
  function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    parts.forEach((p) => {
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    parts = parts.filter((p) => p.y < canvas.height + 30);
    raf = parts.length ? requestAnimationFrame(loop) : (ctx.clearRect(0, 0, canvas.width, canvas.height), null);
  }
  return { burst };
})();

function redFlashShake() {
  const f = $('fx-flash');
  f.classList.remove('red'); void f.offsetWidth; f.classList.add('red');
  document.body.classList.remove('shake'); void document.body.offsetWidth;
  document.body.classList.add('shake');
  setTimeout(() => document.body.classList.remove('shake'), 600);
}
function spotlight() {
  const s = document.createElement('div');
  s.className = 'spotlight';
  document.body.appendChild(s);
  setTimeout(() => s.remove(), 1800);
}

/* ---------------- socket ---------------- */
function connect() {
  S.socket = io();
  const sock = S.socket;

  sock.on('connect', () => {
    // auto-rejoin after a drop, keeping score via stored player id
    if (S.code && S.me.id) {
      sock.emit('join-room', { code: S.code, name: S.me.name, playerId: S.me.id });
    }
  });

  sock.on('room-created', ({ code, player }) => enterRoom(code, player));
  sock.on('room-joined', ({ room, you }) => enterRoom(room.code, you, room));
  sock.on('join-error', ({ message }) => {
    const e = $('home-error'); e.hidden = false; e.textContent = message;
    Sound.wahwah();
  });
  sock.on('error-msg', ({ message }) => { toast(message); Sound.tap(); });

  sock.on('room-state', (room) => { S.room = room; renderRoom(); });
  sock.on('card-names-updated', ({ names }) => {
    S.cardNames = names;
    if (!$('modal-customize').hidden) buildCustomizeList();
    toast('🃏 Card names updated on all devices');
  });

  sock.on('player-event', ({ type, player }) => {
    if (type === 'joined') { toast(`👋 ${player.name} joined`); Sound.notify(); }
    if (type === 'rejoined') { toast(`🔄 ${player.name} reconnected`); Sound.notify(); }
    if (type === 'left') toast(`👋 ${player.name} disconnected`);
    if (type === 'muted') toast(`🔇 ${player.name} was muted by the host`);
  });

  sock.on('your-card', ({ role }) => { S.myRole = role; S.myFlipped = false; });

  sock.on('round-dealt', ({ round }) => startRoundUI(round));

  sock.on('police-declared', ({ playerId, name }) => {
    S.room.policeId = playerId;
    Sound.siren(); spotlight(); Sound.vibrate([80, 60, 120]);
    renderTable();
    if (playerId === S.me.id) {
      $('game-status').textContent = '🎖 You are the Police! Tap who you think is the Thief.';
      buildGuessList();
      $('guess-panel').hidden = false;
    } else {
      $('game-status').textContent = `🚨 ${name} is the Police! They are choosing…`;
      $('guess-panel').hidden = true;
    }
    $('btn-declare').disabled = true;
  });

  sock.on('round-result', (res) => showResult(res));

  sock.on('end-vote', ({ requesterName, approvals, needed }) => {
    S.voted = false;
    $('vote-text').textContent = requesterName
      ? `${requesterName} wants to end the game. Needs ${needed} approvals.`
      : `Vote to end the game in progress.`;
    $('vote-num').textContent = approvals;
    $('vote-needed').textContent = needed;
    $('btn-approve-end').disabled = false;
    $('modal-vote').hidden = false;
    Sound.notify();
  });

  sock.on('game-ended', ({ totals }) => showFinal(totals));
  sock.on('play-again', () => {
    S.myRole = null; S.voted = false;
    showScreen('lobby');
    toast('🔁 New game! Scores reset.');
  });

  wireVoice(sock);
}

function enterRoom(code, player, roomSnapshot) {
  S.code = code;
  S.me = { id: player.id, name: player.name, isHost: player.isHost };
  localStorage.setItem('rr_pid_' + code, player.id);
  localStorage.setItem('rr_name', player.name);
  if (roomSnapshot) { S.room = roomSnapshot; S.cardNames = roomSnapshot.cardNames; }
  $('voice-bar').hidden = false;
  Voice.init(S.socket, player.id, player.isHost);
  renderRoom();
  const link = `${location.origin}/r/${code}`;
  history.replaceState(null, '', `/r/${code}`);
  showScreen('lobby');
  toast(`Welcome, ${player.name}! Code: ${code} · link: ${link}`);
}

/* ---------------- home ---------------- */
function wireHome() {
  const savedName = localStorage.getItem('rr_name') || '';
  $('home-name').value = savedName;
  // deep link: /r/ABC123 or ?room=ABC123
  const m = location.pathname.match(/\/r\/([A-Za-z0-9]{6})/) || location.search.match(/room=([A-Za-z0-9]{6})/i);
  if (m) $('home-code').value = m[1].toUpperCase();

  $('btn-create').onclick = () => {
    Sound.unlock(); Sound.tap();
    const name = $('home-name').value.trim();
    if (!name) return showHomeError('Please enter a display name first.');
    S.socket.emit('create-room', { name });
  };
  $('btn-join').onclick = () => {
    Sound.unlock(); Sound.tap();
    const name = $('home-name').value.trim();
    const code = $('home-code').value.trim().toUpperCase();
    if (!name) return showHomeError('Please enter a display name first.');
    if (!code) return showHomeError('Please enter the room code.');
    const pid = localStorage.getItem('rr_pid_' + code);
    S.socket.emit('join-room', { code, name, playerId: pid || undefined });
  };
}
function showHomeError(msg) {
  const e = $('home-error'); e.hidden = false; e.textContent = msg;
}

/* ---------------- lobby ---------------- */
function renderRoom() {
  const room = S.room;
  if (!room) return;
  if (S.cardNames == null) S.cardNames = room.cardNames;

  if (room.phase === 'lobby' || room.phase === 'ended') {
    renderLobby(room);
    if (!$('screen-lobby').classList.contains('active') && room.phase === 'lobby') showScreen('lobby');
  } else if (room.phase === 'dealt' || room.phase === 'police') {
    renderTable();
    if (!$('screen-game').classList.contains('active')) showScreen('game');
  }
}

function renderLobby(room) {
  $('lobby-code').textContent = room.code;
  $('lobby-myname').textContent = S.me.name;
  $('lobby-count').textContent = room.players.length;
  const ul = $('lobby-players');
  ul.innerHTML = '';
  room.players.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="dot ${p.connected ? '' : 'off'}"></span>` +
      `<span class="avatar">${escapeHTML(p.name.trim()[0] || '?')}</span>` +
      `<span class="pname ml-font">${escapeHTML(p.name)}</span>` +
      (p.isHost ? `<span class="badge-host">HOST</span>` : '') +
      (p.connected ? '' : `<span class="badge-off">offline</span>`);
    ul.appendChild(li);
  });
  const ready = room.players.filter((p) => p.connected).length >= 5;
  $('lobby-waiting').textContent = ready
    ? '✅ Ready! The host can start the round.'
    : `Waiting for players… need at least 5 to start (${room.players.filter((p) => p.connected).length}/5).`;

  const isHost = S.me.isHost;
  $('host-controls').hidden = !isHost;
  $('lobby-guest-note').hidden = isHost;
  if (isHost) {
    $('btn-start').disabled = !ready;
    $('btn-start').onclick = () => { Sound.tap(); S.socket.emit('start-round'); };
    $('btn-customize').onclick = () => { Sound.tap(); buildCustomizeList(); $('modal-customize').hidden = false; };
  }
}

function wireLobby() {
  $('btn-copy-link').onclick = async () => {
    Sound.tap();
    const link = `${location.origin}/r/${S.code}`;
    try { await navigator.clipboard.writeText(link); toast('🔗 Invite link copied!'); }
    catch { prompt('Copy this invite link:', link); }
  };
  $('btn-edit-name').onclick = () => {
    Sound.tap();
    $('name-edit-input').value = S.me.name;
    $('name-editor').hidden = false;
  };
  $('btn-cancel-name').onclick = () => { Sound.tap(); $('name-editor').hidden = true; };
  $('btn-save-name').onclick = () => {
    Sound.tap();
    const v = $('name-edit-input').value.trim();
    if (!v) return toast('Name cannot be empty.');
    S.socket.emit('update-name', { name: v });
    S.me.name = v; // optimistic; server confirms via room-state
    localStorage.setItem('rr_name', v);
    $('name-editor').hidden = true;
  };
  $('btn-reset-cards').onclick = () => { Sound.tap(); S.socket.emit('reset-cards'); };
  $('btn-close-customize').onclick = () => { Sound.tap(); $('modal-customize').hidden = true; };
  // live-save card names as the host types (debounced)
  let saveT = null;
  $('customize-list').addEventListener('input', () => {
    clearTimeout(saveT);
    saveT = setTimeout(saveCustomCards, 600);
  });
}

function buildCustomizeList() {
  const wrap = $('customize-list');
  wrap.innerHTML = '';
  ROLE_LIST.forEach((role) => {
    const cur = (S.cardNames && S.cardNames[role]) || { en: '', ml: '' };
    const row = document.createElement('div');
    row.className = 'custom-row';
    row.innerHTML =
      `<span class="rlabel">${ROLE_UI[role].icon} ${role}</span>` +
      `<input class="text-input" data-role="${role}" data-kind="en" maxlength="24" placeholder="English" value="${escapeHTML(cur.en)}">` +
      `<input class="text-input ml-font" data-role="${role}" data-kind="ml" maxlength="24" placeholder="മലയാളം" value="${escapeHTML(cur.ml)}">`;
    wrap.appendChild(row);
  });
}
function saveCustomCards() {
  const names = {};
  ROLE_LIST.forEach((role) => { names[role] = { en: '', ml: '' }; });
  $('customize-list').querySelectorAll('input').forEach((inp) => {
    names[inp.dataset.role][inp.dataset.kind] = inp.value;
  });
  S.socket.emit('customize-cards', { names });
}

/* ---------------- game table ---------------- */
function startRoundUI(round) {
  S.myFlipped = false;
  $('round-banner').textContent = `Round ${round}`;
  $('game-status').textContent = '';
  $('guess-panel').hidden = true;
  $('btn-declare').disabled = false;
  showScreen('game');
  // shuffle animation then deal
  const table = $('table');
  table.innerHTML = `<div id="shuffle-deck">${'<div class="mini-card">👑</div>'.repeat(5)}</div>`;
  $('my-card-zone').style.visibility = 'hidden';
  Sound.shuffle();
  setTimeout(() => {
    $('my-card-zone').style.visibility = 'visible';
    resetMyCard();
    table.innerHTML = ''; // clear the shuffle animation
    renderTable();
    Sound.deal();
  }, 1500);
}

function resetMyCard() {
  const card = $('my-card');
  card.classList.remove('flipped');
  card.className = 'card facedown';
  $('my-card-front').innerHTML = '';
}

function renderTable() {
  const room = S.room;
  if (!room) return;
  const table = $('table');
  if ($('shuffle-deck')) return; // animation still playing
  table.innerHTML = '';
  room.players.forEach((p) => {
    if (!p.connected) return;
    const seat = document.createElement('div');
    seat.className = 'seat' + (p.id === S.me.id ? ' me' : '') +
      (room.policeId === p.id ? ' police-spot' : '');
    seat.innerHTML =
      `<div class="mini-card">${room.policeId === p.id ? '👮' : '🂠'}</div>` +
      `<div class="pname ml-font">${escapeHTML(p.name)}${p.id === S.me.id ? ' (you)' : ''}</div>`;
    table.appendChild(seat);
  });
}

function wireGame() {
  const card = $('my-card');
  const flip = () => {
    if (!S.myRole || S.myFlipped) return;
    Sound.unlock(); Sound.flip();
    const ui = ROLE_UI[S.myRole];
    $('my-card-front').innerHTML =
      `<div class="role-icon">${ui.icon}</div>` +
      roleNameHTML(S.myRole) +
      `<div class="role-points">${ui.hidden ? 'points: ?' : ui.points + ' pts'}</div>`;
    card.classList.remove('facedown');
    card.classList.add('flipped', 'role-' + S.myRole);
    S.myFlipped = true;
  };
  card.addEventListener('click', flip);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') flip(); });

  $('btn-declare').onclick = () => { Sound.tap(); S.socket.emit('declare-police'); };
}

function buildGuessList() {
  const ul = $('guess-list');
  ul.innerHTML = '';
  S.room.players.forEach((p) => {
    if (!p.connected || p.id === S.me.id) return;
    const li = document.createElement('li');
    li.innerHTML = `<span class="avatar">🕵️</span><span class="pname ml-font">${escapeHTML(p.name)}</span>`;
    li.onclick = () => {
      Sound.tap();
      if (confirm(`Accuse ${p.name} of being the Thief?`)) {
        S.socket.emit('guess-thief', { targetId: p.id });
      }
    };
    ul.appendChild(li);
  });
}

/* ---------------- reveal & leaderboard ---------------- */
function showResult(res) {
  const banner = $('result-banner');
  if (res.correct) {
    banner.className = 'result-banner win';
    banner.textContent = `🎉 Caught! ${res.thiefName} was the Thief!`;
    Sound.win(); Sound.vibrate([100, 50, 100, 50, 200]);
    Confetti.burst(200);
  } else {
    banner.className = 'result-banner lose';
    banner.textContent = `😱 Wrong! The real Thief was ${res.thiefName}.`;
    Sound.wahwah(); Sound.vibrate([300, 100, 300]);
    redFlashShake();
  }
  spotlight();

  // all cards revealed
  const grid = $('reveal-cards');
  grid.innerHTML = '';
  S.room.players.forEach((p) => {
    const role = res.roles[p.id];
    if (!role) return;
    const ui = ROLE_UI[role];
    const d = document.createElement('div');
    d.className = 'reveal-card';
    d.innerHTML =
      `<div class="who ml-font">${escapeHTML(p.name)}</div>` +
      `<div class="what">${ui.icon}</div>` +
      `<div class="ml-font">${roleNameHTML(role)}</div>` +
      `<div class="pts">+${res.roundPoints[p.id] ?? 0} pts</div>`;
    grid.appendChild(d);
  });

  renderLeaderboard($('leaderboard'), res.totals, res.roundPoints);
  $('totals-round').textContent = `· after round ${S.room.round}`;

  $('btn-next-round').hidden = !S.me.isHost;
  $('btn-next-round').onclick = () => { Sound.tap(); S.socket.emit('next-round'); };
  showScreen('reveal');
}

function renderLeaderboard(ol, totals, roundPoints) {
  ol.innerHTML = '';
  totals.forEach((t, i) => {
    const li = document.createElement('li');
    if (i === 0) li.className = 'leader';
    const medal = i === 0 ? '👑' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    li.style.animation = `fadeUp .4s ease ${i * 0.08}s both`;
    li.innerHTML =
      `<span class="rank">${medal}</span>` +
      `<span class="lname ml-font">${escapeHTML(t.name)}</span>` +
      (roundPoints && roundPoints[t.id] != null ? `<span class="float-pts" style="position:static;animation:none;color:#7CFC00">+${roundPoints[t.id]}</span>` : '') +
      `<span class="lscore">${t.score}</span>`;
    ol.appendChild(li);
  });
  // points tick sound cascade
  if (roundPoints) {
    let i = 0;
    const iv = setInterval(() => { Sound.tick(); if (++i > totals.length) clearInterval(iv); }, 120);
  }
}

function wireReveal() {
  $('btn-end-game').onclick = () => { Sound.tap(); S.socket.emit('request-end'); };
  $('btn-approve-end').onclick = () => {
    Sound.tap(); S.voted = true;
    $('btn-approve-end').disabled = true;
    S.socket.emit('approve-end');
  };
  $('btn-close-vote').onclick = () => { Sound.tap(); $('modal-vote').hidden = true; };
}

/* ---------------- final ---------------- */
function showFinal(totals) {
  $('modal-vote').hidden = true;
  const winner = totals[0];
  $('final-winner').innerHTML = winner
    ? `👑 Winner: <b class="ml-font">${escapeHTML(winner.name)}</b> with ${winner.score} points!`
    : 'No scores.';
  renderLeaderboard($('final-board'), totals, null);
  $('btn-play-again').hidden = !S.me.isHost;
  $('btn-play-again').onclick = () => { Sound.tap(); S.socket.emit('play-again'); };
  showScreen('final');
  Sound.fanfare();
  Confetti.burst(300);
  setTimeout(() => Confetti.burst(200), 1200);
}

function wireFinal() {
  $('btn-new-room').onclick = () => {
    Sound.tap();
    localStorage.removeItem('rr_pid_' + S.code);
    location.href = '/';
  };
}

/* ---------------- voice UI ---------------- */
function wireVoice(sock) {
  const bar = $('voice-bar'), ptt = $('btn-ptt'), ind = $('speaker-indicator');

  const press = (e) => { e.preventDefault(); Sound.unlock(); ptt.classList.add('talking'); Voice.pressToTalk(); };
  const release = () => { ptt.classList.remove('talking'); Voice.releaseTalk(); };
  ptt.addEventListener('pointerdown', press);
  ptt.addEventListener('pointerup', release);
  ptt.addEventListener('pointercancel', release);
  ptt.addEventListener('pointerleave', release);

  Voice.on('speaker', ({ playerId, name, me }) => {
    if (!playerId) { ind.className = ''; ind.textContent = '🔇 Voice — free'; }
    else if (me) { ind.className = 'speaking'; ind.textContent = '🎙 You are speaking…'; }
    else { ind.className = 'busy'; ind.textContent = `🎙 ${name} speaking…`; }
  });
  Voice.on('busy', () => {
    ind.className = 'busy'; ind.textContent = '⏳ Busy — someone is speaking';
    ptt.classList.remove('talking');
    setTimeout(() => { if (ind.classList.contains('busy')) { ind.className = ''; ind.textContent = '🔇 Voice — free'; } }, 1500);
  });
  Voice.on('mic-denied', () => {
    ptt.classList.add('denied'); ptt.disabled = true;
    ptt.textContent = '🚫 Mic blocked';
    toast('Microphone blocked. Allow mic access in the browser to use voice chat.');
  });
  Voice.on('muted-by-host', () => toast('🔇 The host muted you'));

  $('btn-mic-settings').onclick = () => {
    Sound.tap();
    const wrap = $('voice-players');
    wrap.innerHTML = '';
    (S.room?.players || []).forEach((p) => {
      if (p.id === S.me.id) return;
      const row = document.createElement('div');
      row.className = 'custom-row';
      row.innerHTML = `<span class="rlabel ml-font">${escapeHTML(p.name)}</span><span></span>` +
        (S.me.isHost ? `<button class="btn btn-small btn-danger">🔇 Mute</button>` : `<span class="hint">—</span>`);
      const btn = row.querySelector('button');
      if (btn) btn.onclick = () => { Sound.tap(); Voice.mutePlayer(p.id); toast(`🔇 Muted ${p.name}`); };
      wrap.appendChild(row);
    });
    $('modal-voice').hidden = false;
  };
  $('btn-close-voice').onclick = () => { Sound.tap(); $('modal-voice').hidden = true; };
}

/* ---------------- sound UI ---------------- */
function wireSound() {
  const btn = $('btn-sound'), vol = $('volume');
  const paint = () => { btn.textContent = Sound.isEnabled() ? '🔊' : '🔇'; };
  vol.value = Math.round(Sound.getVolume() * 100);
  paint();
  document.addEventListener('pointerdown', () => Sound.unlock(), { once: true });
  btn.onclick = () => { Sound.unlock(); Sound.setEnabled(!Sound.isEnabled()); paint(); Sound.tap(); };
  vol.oninput = () => Sound.setVolume(vol.value / 100);
}

/* ---------------- boot ---------------- */
connect();
wireHome();
wireLobby();
wireGame();
wireReveal();
wireFinal();
wireSound();
