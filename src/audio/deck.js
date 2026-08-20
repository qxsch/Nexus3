import { analyzeBuffer } from './analyzer.js';

const KILL_DB = -60;

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/**
 * One mixer channel + one virtual turntable.
 * turntable/stream -> trim -> keylock -> 3-band EQ -> filter -> PFL tap
 *   -> channel fader -> crossfader gain -> master
 * The PFL tap also feeds the FX send bus and the headphone cue bus.
 */
export class Deck extends EventTarget {
  constructor(engine, index, meta) {
    super();
    this.engine = engine;
    this.ctx = engine.ctx;
    this.index = index;
    this.label = meta.label;
    this.color = meta.color;

    this.title = '';
    this.buffer = null;
    this.analysis = null;
    this.meta = {};
    this.bpm = 0;
    this.beatOffset = 0;
    this.duration = 0;
    this.sourceMode = 'buffer';

    this.tempo = 1;
    this.pitchRange = 0.16;
    this.keylock = false;
    this.syncEnabled = false;
    this.playing = false;
    this.reverse = false;
    this.cuePoint = 0;
    this.hotCues = new Array(8).fill(null);
    this.loop = { active: false, beats: 4, start: 0, end: 0 };
    this.assign = 'THRU';
    this.cueOn = false;

    this._pos = 0;
    this._rate = 0;
    this._posAt = 0;
    this._preview = false;
    this._nudge = 1;

    this.#build();
  }

  #build() {
    const ctx = this.ctx;

    this.turntable = new AudioWorkletNode(ctx, 'turntable-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    this.turntable.port.onmessage = (e) => this.#onWorkletMessage(e.data);

    this.streamGain = ctx.createGain();
    this.streamGain.gain.value = 1;

    this.trim = ctx.createGain();
    this.trim.gain.value = 1;

    this.keylockNode = new AudioWorkletNode(ctx, 'keylock-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    this.keylockNode.port.postMessage({ type: 'enable', value: false });

    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 90;
    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.9;
    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 11000;

    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 20;
    this.hp.Q.value = 0.9;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 20000;
    this.lp.Q.value = 0.9;

    this.pfl = ctx.createGain();
    this.fader = ctx.createGain();
    this.fader.gain.value = 0.8;
    this.xf = ctx.createGain();
    this.xf.gain.value = 1;

    this.fxSend = ctx.createGain();
    this.fxSend.gain.value = 0;
    this.cueSend = ctx.createGain();
    this.cueSend.gain.value = 0;

    this.turntable.connect(this.trim);
    this.streamGain.connect(this.trim);
    this.trim.connect(this.keylockNode);
    this.keylockNode
      .connect(this.eqLow)
      .connect(this.eqMid)
      .connect(this.eqHigh)
      .connect(this.hp)
      .connect(this.lp)
      .connect(this.pfl);

    this.pfl.connect(this.fader).connect(this.xf).connect(this.engine.masterSum);
    this.pfl.connect(this.fxSend).connect(this.engine.fxBus);
    this.pfl.connect(this.cueSend).connect(this.engine.cueBus);

    this.level = { peakL: 0, peakR: 0, rms: 0 };
    this.engine.createMeter(this.pfl, (data) => {
      this.level = data;
    });
  }

  #onWorkletMessage(msg) {
    if (msg.type === 'position') {
      this._pos = msg.position;
      this._rate = msg.rate;
      this._posAt = this.ctx.currentTime;
      this.playing = msg.playing;
    } else if (msg.type === 'ended') {
      this.playing = false;
      this._preview = false;
      this.dispatchEvent(new CustomEvent('ended'));
      this.dispatchEvent(new CustomEvent('state'));
    }
  }

  get sampleRate() {
    return this.ctx.sampleRate;
  }

  get loaded() {
    return !!this.buffer || this.sourceMode === 'stream';
  }

  get effectiveBpm() {
    return this.bpm ? this.bpm * this.tempo : 0;
  }

  get pitchPercent() {
    return (this.tempo - 1) * 100;
  }

  positionFrames() {
    if (this.sourceMode === 'stream') return (this.media?.currentTime ?? 0) * this.sampleRate;
    const dt = this.ctx.currentTime - this._posAt;
    const p = this._pos + this._rate * dt * this.sampleRate;
    return Math.max(0, Math.min(this.buffer ? this.buffer.length - 1 : 0, p));
  }

  positionSeconds() {
    return this.positionFrames() / this.sampleRate;
  }

  currentRate() {
    if (this.sourceMode === 'stream') return this.playing ? this.tempo : 0;
    return this._rate;
  }

  // ---------------------------------------------------------------- loading

  async load(audioBuffer, title, options = {}) {
    this.unloadStream();
    this.sourceMode = 'buffer';
    this.buffer = audioBuffer;
    this.title = title;
    this.meta = options.meta ?? {};
    this.duration = audioBuffer.duration;
    this._pos = 0;
    this._rate = 0;
    this.playing = false;
    this.cuePoint = 0;
    this.hotCues.fill(null);
    this.loop.active = false;

    const channels = [];
    const transfers = [];
    for (let c = 0; c < Math.min(2, audioBuffer.numberOfChannels); c++) {
      const copy = audioBuffer.getChannelData(c).slice();
      channels.push(copy);
      transfers.push(copy.buffer);
    }
    this.turntable.port.postMessage(
      { type: 'load', channels, length: audioBuffer.length },
      transfers
    );

    this.analysis = null;
    this.bpm = 0;
    this.dispatchEvent(new CustomEvent('loaded'));

    const result = options.analysis ?? (await analyzeBuffer(audioBuffer));
    this.analysis = result;
    this.bpm = result.bpm;
    this.beatOffset = result.beatOffset;
    this.dispatchEvent(new CustomEvent('analyzed'));
    this.dispatchEvent(new CustomEvent('state'));
    return result;
  }

  async loadStream(url, title) {
    this.turntable.port.postMessage({ type: 'unload' });
    this.unloadStream();
    this.sourceMode = 'stream';
    this.buffer = null;
    this.analysis = null;
    this.bpm = 0;
    this.title = title || url;

    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = url;
    this.media = el;
    this.mediaSource = this.ctx.createMediaElementSource(el);
    this.mediaSource.connect(this.streamGain);
    el.addEventListener('loadedmetadata', () => {
      this.duration = isFinite(el.duration) ? el.duration : 0;
      this.dispatchEvent(new CustomEvent('state'));
    });
    this.dispatchEvent(new CustomEvent('loaded'));
    this.dispatchEvent(new CustomEvent('state'));
  }

  unloadStream() {
    if (this.media) {
      this.media.pause();
      try {
        this.mediaSource.disconnect();
      } catch {}
      this.media.src = '';
      this.media = null;
      this.mediaSource = null;
    }
  }

  // -------------------------------------------------------------- transport

  play() {
    if (!this.loaded) return;
    if (this.sourceMode === 'stream') {
      this.media.play().catch(() => {});
      this.playing = true;
    } else {
      this.turntable.port.postMessage({ type: 'play' });
      this.playing = true;
    }
    this.dispatchEvent(new CustomEvent('state'));
  }

  pause() {
    if (this.sourceMode === 'stream') this.media?.pause();
    else this.turntable.port.postMessage({ type: 'pause' });
    this.playing = false;
    this.dispatchEvent(new CustomEvent('state'));
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seekSeconds(seconds) {
    const s = Math.max(0, Math.min(this.duration || 0, seconds));
    if (this.sourceMode === 'stream') {
      if (this.media) this.media.currentTime = s;
    } else {
      this._pos = s * this.sampleRate;
      this._posAt = this.ctx.currentTime;
      this.turntable.port.postMessage({ type: 'seek', position: this._pos });
    }
    this.dispatchEvent(new CustomEvent('state'));
  }

  setCuePointHere() {
    this.cuePoint = this.positionSeconds();
    this.dispatchEvent(new CustomEvent('state'));
  }

  pressCue() {
    if (!this.loaded) return;
    if (this.playing) {
      this.pause();
      this.seekSeconds(this.cuePoint);
    } else {
      const at = this.positionSeconds();
      if (Math.abs(at - this.cuePoint) > 0.02) {
        this.setCuePointHere();
      }
      this._preview = true;
      this.play();
    }
  }

  releaseCue() {
    if (!this._preview) return;
    this._preview = false;
    this.pause();
    this.seekSeconds(this.cuePoint);
  }

  setHotCue(i) {
    this.hotCues[i] = this.positionSeconds();
    this.dispatchEvent(new CustomEvent('state'));
  }

  jumpHotCue(i) {
    const c = this.hotCues[i];
    if (c == null) {
      this.setHotCue(i);
      return;
    }
    this.seekSeconds(c);
    if (!this.playing) this.play();
  }

  clearHotCue(i) {
    this.hotCues[i] = null;
    this.dispatchEvent(new CustomEvent('state'));
  }

  // ------------------------------------------------------------------ pitch

  setTempo(value) {
    this.tempo = Math.max(0.2, Math.min(4, value));
    if (this.sourceMode === 'stream') {
      if (this.media) this.media.playbackRate = this.tempo;
    } else {
      this.turntable.port.postMessage({ type: 'tempo', value: this.tempo });
    }
    this.keylockNode.parameters
      .get('shift')
      .setTargetAtTime(1 / this.tempo, this.ctx.currentTime, 0.02);
    this.dispatchEvent(new CustomEvent('state'));
  }

  setPitchPercent(p) {
    this.setTempo(1 + p / 100);
  }

  setNudge(value) {
    this._nudge = value;
    if (this.sourceMode === 'stream') {
      if (this.media) this.media.playbackRate = this.tempo * value;
    } else {
      this.turntable.port.postMessage({ type: 'nudge', value });
    }
  }

  setKeylock(on) {
    this.keylock = !!on;
    this.keylockNode.port.postMessage({ type: 'enable', value: this.keylock });
    this.dispatchEvent(new CustomEvent('state'));
  }

  setReverse(on) {
    this.reverse = !!on;
    this.turntable.port.postMessage({ type: 'reverse', value: this.reverse });
    this.dispatchEvent(new CustomEvent('state'));
  }

  // -------------------------------------------------------------- jog wheel

  platterTouch(down) {
    if (this.sourceMode !== 'buffer') return;
    this.turntable.port.postMessage({ type: 'platter', held: down });
  }

  scratch(rate) {
    if (this.sourceMode !== 'buffer') return;
    this.turntable.port.postMessage({ type: 'jog', active: true, rate });
  }

  scratchEnd() {
    if (this.sourceMode !== 'buffer') return;
    this.turntable.port.postMessage({ type: 'jog', active: false, rate: 0 });
  }

  bend(amount) {
    this.setNudge(1 + amount);
  }

  bendEnd() {
    this.setNudge(1);
  }

  // ------------------------------------------------------------------ loops

  secondsPerBeat() {
    return this.bpm ? 60 / this.bpm : 0.5;
  }

  quantizeToBeat(seconds) {
    if (!this.bpm) return seconds;
    const spb = this.secondsPerBeat();
    const n = Math.round((seconds - this.beatOffset) / spb);
    return this.beatOffset + n * spb;
  }

  setLoop(beats) {
    if (this.sourceMode !== 'buffer' || !this.buffer) return;
    this.loop.beats = beats;
    const start = this.quantizeToBeat(this.positionSeconds());
    const end = start + beats * this.secondsPerBeat();
    this.loop.start = start;
    this.loop.end = end;
    this.loop.active = true;
    this.turntable.port.postMessage({
      type: 'loop',
      active: true,
      start: start * this.sampleRate,
      end: end * this.sampleRate
    });
    this.dispatchEvent(new CustomEvent('state'));
  }

  scaleLoop(factor) {
    if (!this.loop.active) return;
    this.setLoop(Math.max(0.125, Math.min(32, this.loop.beats * factor)));
  }

  exitLoop() {
    this.loop.active = false;
    this.turntable.port.postMessage({ type: 'loop', active: false });
    this.dispatchEvent(new CustomEvent('state'));
  }

  // ------------------------------------------------------------ mixer strip

  setTrim(gain) {
    this.trim.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
  }

  setEq(band, db) {
    const t = this.ctx.currentTime;
    const node = band === 'low' ? this.eqLow : band === 'mid' ? this.eqMid : this.eqHigh;
    node.gain.setTargetAtTime(db, t, 0.02);
  }

  setKill(band, killed) {
    this.setEq(band, killed ? KILL_DB : 0);
  }

  /** Bipolar colour filter: -1 = low-pass sweep, 0 = off, +1 = high-pass sweep. */
  setFilter(value) {
    const t = this.ctx.currentTime;
    const v = Math.max(-1, Math.min(1, value));
    if (v < -0.01) {
      const f = 20000 * Math.pow(120 / 20000, -v);
      this.lp.frequency.setTargetAtTime(f, t, 0.02);
      this.hp.frequency.setTargetAtTime(20, t, 0.02);
      this.lp.Q.setTargetAtTime(0.9 + 4 * -v, t, 0.02);
    } else if (v > 0.01) {
      const f = 20 * Math.pow(9000 / 20, v);
      this.hp.frequency.setTargetAtTime(f, t, 0.02);
      this.lp.frequency.setTargetAtTime(20000, t, 0.02);
      this.hp.Q.setTargetAtTime(0.9 + 4 * v, t, 0.02);
    } else {
      this.lp.frequency.setTargetAtTime(20000, t, 0.02);
      this.hp.frequency.setTargetAtTime(20, t, 0.02);
      this.lp.Q.setTargetAtTime(0.9, t, 0.02);
      this.hp.Q.setTargetAtTime(0.9, t, 0.02);
    }
  }

  setFxSend(amount) {
    this.fxSend.gain.setTargetAtTime(amount, this.ctx.currentTime, 0.02);
  }

  setFader(v) {
    this.fader.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.01);
  }

  setCue(on) {
    this.cueOn = !!on;
    this.cueSend.gain.setTargetAtTime(this.cueOn ? 1 : 0, this.ctx.currentTime, 0.02);
    this.dispatchEvent(new CustomEvent('state'));
  }

  setCrossfadeGain(g) {
    this.xf.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01);
  }
}

export { dbToGain };
