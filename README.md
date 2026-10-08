# Raja Rani — കള്ളൻ പോലീസ്

A real-time multiplayer card game for phones and laptops. One player creates a room,
friends join with a short code, and everyone plays from their own device.

**Stack:** Node.js + Express + Socket.IO (server), plain HTML/CSS/JS with no build
step (frontend). Voice chat via WebRTC (full mesh, Socket.IO signalling). All sound
effects are synthesized with the Web Audio API — no audio files needed.

## Quick start (local)

```bash
npm install
npm start
```

Open http://localhost:3000 — create a room on one device, join from others with the
6-letter code (or the shareable `/r/CODE` link).

> On a local network, open the game via your machine's LAN address
> (e.g. `http://192.168.1.5:3000`) so phones can reach it.

## How to play

1. Host creates a room, friends join (minimum 5 players, no maximum).
2. Host taps **Start round**. Everyone gets a secret card — tap it to peek.
3. Whoever holds the **Police** card taps **"I am the Police"** 🚨.
4. The Police taps the player they believe is the **Thief** 🥷.
5. Correct guess → Police scores 500, Thief 0. Wrong guess → Thief steals 500, Police 0.
   Everyone else scores their card's points. Leaderboard updates live.
6. Host taps **Next round**. Any player can request **End game** (needs 4 approvals).

### Roles & points (`server.js` → `ROLE_POINTS`, easy to edit)

| Players | Cards dealt |
|---|---|
| 5 | King 1000, Queen 800, Minister 600, Police 500, Thief 0 |
| 6 | + Prince 700 |
| 7 | + Princess 700 |
| 8+ | + Soldiers 500 each |

Exactly one Police and one Thief every round. Police/Thief card points show as
hidden (`?`) until the round resolves.

### Card names

The host can open **Customize cards** in the lobby and rename any role in English
and/or Malayalam (e.g. Thief → കള്ളൻ, Police → പോലീസ്). Malayalam renders large
with English below, using Noto Sans Malayalam from Google Fonts. Changes apply to
all devices instantly and persist for later rounds. **Reset to default** restores
the originals. Points are never editable.

### Voice chat

Hold the **🎙 Hold to talk** button to speak — only one person at a time; others
see "Busy". The host can interrupt (just hold to talk) and can mute any player
from the ⚙️ voice settings. The first press asks for microphone permission with a
clear explanation; if denied, the button disables gracefully and the game still works.

> 🎤 **Microphone requires HTTPS** (or `localhost`). Plain `http://` on a LAN IP
> will block mic access in most browsers.

## Deploying

Voice chat needs HTTPS, so use a host that provides it:

- **Render** — new Web Service → connect this repo → Build: `npm install`,
  Start: `npm start`. Free tier works; note it sleeps when idle.
- **Railway** — new project from repo → it auto-detects `npm start`.
- Any Node host / VPS with a reverse proxy + TLS certificate.

The app reads `PORT` from the environment (falls back to `3000`).

## Project layout

```
server.js            # Express + Socket.IO: rooms, dealing, scoring, votes, voice floor
public/
  index.html         # all screens: home, lobby, table, reveal, final + modals
  css/style.css      # mobile-first flashy theme, 3D card flips, fx, reduced-motion
  js/app.js          # game client: screens, round flow, leaderboard, confetti
  js/audio.js        # Web Audio synth: shuffle, flip, siren, jingles, volume
  js/voice.js        # WebRTC mesh + push-to-talk floor control
```

## Notes & limits

- Rooms live in memory — restarting the server clears them (fine for party play).
- Disconnects keep the player's score; rejoining with the same device restores
  their seat and secret card automatically.
- Duplicate display names in a room are rejected; names lock once play starts.
- Honors `prefers-reduced-motion` by simplifying animations.
