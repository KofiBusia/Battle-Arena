// ============================================================================
// Battle Arena — audio system
// All sound effects are synthesized at runtime with the Web Audio API, so
// there are no external audio files to fetch (and nothing to break if a
// file is missing). Everything is generated from oscillators + noise buffers.
// ============================================================================

class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
    this.enabled = true;
    this.musicEnabled = true;
    this._ambientTimer = null;
  }

  // Audio contexts must be created/resumed after a user gesture in most
  // browsers, so this is called lazily on first interaction.
  _ensureContext() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
  }

  resume() {
    this._ensureContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  setEnabled(on) { this.enabled = on; }
  setMusicEnabled(on) {
    this.musicEnabled = on;
    if (!on) this.stopAmbient();
  }

  _noiseBuffer(duration) {
    const ctx = this.ctx;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  _envGain(startVal, endVal, duration, delay = 0) {
    const g = this.ctx.createGain();
    const t0 = this.ctx.currentTime + delay;
    g.gain.setValueAtTime(startVal, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(endVal, 0.0001), t0 + duration);
    return g;
  }

  _playTone({ freq, endFreq, type = 'sine', duration = 0.15, gain = 0.3, delay = 0 }) {
    if (!this.enabled) return;
    this._ensureContext();
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + duration);
    const env = this._envGain(gain, 0.001, duration, delay);
    osc.connect(env).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  _playNoise({ duration = 0.2, gain = 0.3, delay = 0, filterFreq = 1200, filterType = 'lowpass' }) {
    if (!this.enabled) return;
    this._ensureContext();
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(duration);
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    const env = this._envGain(gain, 0.001, duration, delay);
    src.connect(filter).connect(env).connect(this.master);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
  }

  // --- Named effects -------------------------------------------------------

  attack() {
    this._playTone({ freq: 880, endFreq: 340, type: 'sawtooth', duration: 0.11, gain: 0.18 });
  }

  hit() {
    this._playNoise({ duration: 0.12, gain: 0.35, filterFreq: 1800 });
    this._playTone({ freq: 180, endFreq: 60, type: 'square', duration: 0.12, gain: 0.15 });
  }

  ownHit() {
    this._playNoise({ duration: 0.18, gain: 0.4, filterFreq: 900 });
    this._playTone({ freq: 140, endFreq: 50, type: 'square', duration: 0.2, gain: 0.25 });
  }

  powerup(type) {
    const freqMap = { speed: 660, health: 523, shield: 440, rapid: 740, damage: 300 };
    const base = freqMap[type] || 523;
    this._playTone({ freq: base, endFreq: base * 2, type: 'triangle', duration: 0.18, gain: 0.22 });
    this._playTone({ freq: base * 1.5, endFreq: base * 2.5, type: 'sine', duration: 0.22, gain: 0.15, delay: 0.06 });
  }

  death() {
    this._playTone({ freq: 400, endFreq: 60, type: 'sawtooth', duration: 0.5, gain: 0.25 });
    this._playNoise({ duration: 0.4, gain: 0.3, filterFreq: 500 });
  }

  roundStartBeep() {
    this._playTone({ freq: 520, type: 'sine', duration: 0.12, gain: 0.2 });
  }

  roundGo() {
    this._playTone({ freq: 520, endFreq: 1040, type: 'sine', duration: 0.35, gain: 0.3 });
  }

  victory() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      this._playTone({ freq: f, type: 'triangle', duration: 0.28, gain: 0.22, delay: i * 0.13 });
    });
  }

  click() {
    this._playTone({ freq: 300, endFreq: 500, type: 'sine', duration: 0.06, gain: 0.12 });
  }

  meleeSwing() {
    this._playNoise({ duration: 0.09, gain: 0.28, filterFreq: 2600, filterType: 'bandpass' });
    this._playTone({ freq: 220, endFreq: 90, type: 'square', duration: 0.08, gain: 0.14 });
  }

  killstreak() {
    const notes = [660, 880, 1108.7];
    notes.forEach((f, i) => {
      this._playTone({ freq: f, type: 'square', duration: 0.16, gain: 0.2, delay: i * 0.08 });
    });
  }

  // --- Ambient background pad --------------------------------------------
  // A sparse, low-volume generative loop — a couple of soft sine notes from
  // a minor scale every few seconds. Purely atmospheric; never competes with
  // SFX for attention. Started when a round begins, stopped when it ends.
  startAmbient() {
    if (!this.musicEnabled || this._ambientTimer) return;
    this._ensureContext();
    const scale = [220, 261.63, 293.66, 329.63, 392, 440]; // A minor-ish pentatonic-ish pool
    const playChord = () => {
      if (!this.musicEnabled) return;
      const root = scale[Math.floor(Math.random() * scale.length)];
      const third = scale[Math.floor(Math.random() * scale.length)];
      [root, third].forEach((f, i) => {
        this._playTone({ freq: f / 2, type: 'sine', duration: 2.4, gain: 0.045, delay: i * 0.05 });
      });
    };
    playChord();
    this._ambientTimer = setInterval(playChord, 3200);
  }

  stopAmbient() {
    if (this._ambientTimer) {
      clearInterval(this._ambientTimer);
      this._ambientTimer = null;
    }
  }
}

const AUDIO = new AudioManager();
