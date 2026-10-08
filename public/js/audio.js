/**
 * Raja Rani — procedural sound effects via Web Audio API.
 * No external files. AudioContext is created lazily on first user tap
 * (browsers block autoplay). Settings persist in localStorage.
 */
'use strict';

const Sound = (() => {
  let ctx = null;
  let master = null;
  let enabled = localStorage.getItem('rr_sound') !== 'off';
  let volume = parseFloat(localStorage.getItem('rr_volume') ?? '0.7');

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = enabled ? volume : 0;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  // Call from the first user gesture.
  function unlock() { ensure(); }

  function setEnabled(on) {
    enabled = on;
    localStorage.setItem('rr_sound', on ? 'on' : 'off');
    if (master) master.gain.value = on ? volume : 0;
  }
  function setVolume(v) {
    volume = Math.min(1, Math.max(0, v));
    localStorage.setItem('rr_volume', String(volume));
    if (master && enabled) master.gain.value = volume;
  }
  const isEnabled = () => enabled;
  const getVolume = () => volume;

  function ready() { return enabled && ensure(); }

  /** Short oscillator blip. */
  function tone({ freq = 440, freqEnd = null, dur = 0.15, type = 'sine', at = 0, gain = 0.5 }) {
    if (!ready()) return;
    const t0 = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  /** Filtered noise burst (cards, swishes). */
  function noise({ dur = 0.1, at = 0, gain = 0.4, filterFreq = 3000, type = 'highpass' }) {
    if (!ready()) return;
    const t0 = ctx.currentTime + at;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = filterFreq;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(f).connect(g).connect(master);
    src.start(t0);
  }

  // ---- named effects ----
  const tap = () => tone({ freq: 660, dur: 0.06, type: 'triangle', gain: 0.25 });
  const flip = () => { noise({ dur: 0.08, filterFreq: 2500, gain: 0.3 }); tone({ freq: 520, freqEnd: 760, dur: 0.09, type: 'triangle', gain: 0.2 }); };
  const deal = () => { noise({ dur: 0.18, filterFreq: 1200, type: 'bandpass', gain: 0.35 }); tone({ freq: 220, dur: 0.07, at: 0.16, type: 'sine', gain: 0.3 }); };
  function shuffle() {
    // rapid flutter of short noise bursts
    for (let i = 0; i < 14; i++) {
      noise({ dur: 0.05, at: i * 0.055, filterFreq: 1800 + Math.random() * 2500, gain: 0.22 });
    }
  }
  function siren() {
    // dramatic police stinger: rising siren wail
    for (let i = 0; i < 3; i++) {
      tone({ freq: 600, freqEnd: 1200, dur: 0.28, at: i * 0.3, type: 'sawtooth', gain: 0.22 });
      tone({ freq: 1200, freqEnd: 600, dur: 0.28, at: i * 0.3 + 0.15, type: 'sawtooth', gain: 0.18 });
    }
    tone({ freq: 880, dur: 0.4, at: 0.95, type: 'triangle', gain: 0.3 });
  }
  function win() {
    // cheerful catch jingle: ascending arpeggio
    [523, 659, 784, 1047, 1319].forEach((f, i) =>
      tone({ freq: f, dur: 0.22, at: i * 0.11, type: 'triangle', gain: 0.35 }));
  }
  function wahwah() {
    // comic sad trombone for a wrong guess
    const seq = [[392, 0], [370, 0.22], [349, 0.44], [311, 0.66]];
    seq.forEach(([f, at], i) =>
      tone({ freq: f, freqEnd: f * 0.94, dur: i === 3 ? 0.6 : 0.24, at, type: 'sawtooth', gain: 0.25 }));
  }
  function tick() { tone({ freq: 1200, dur: 0.03, type: 'square', gain: 0.12 }); }
  function fanfare() {
    [523, 523, 659, 784, 784, 1047].forEach((f, i) =>
      tone({ freq: f, dur: 0.3, at: i * 0.16, type: 'triangle', gain: 0.35 }));
    tone({ freq: 1319, dur: 0.8, at: 1.0, type: 'triangle', gain: 0.4 });
    noise({ dur: 0.5, at: 1.0, filterFreq: 6000, gain: 0.12 });
  }
  const notify = () => { tone({ freq: 880, dur: 0.12, type: 'sine', gain: 0.25 }); tone({ freq: 1175, dur: 0.14, at: 0.13, type: 'sine', gain: 0.25 }); };

  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* unsupported */ }
  }

  return { unlock, tap, flip, deal, shuffle, siren, win, wahwah, tick, fanfare, notify, vibrate,
           setEnabled, setVolume, isEnabled, getVolume };
})();
