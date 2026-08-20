import { DECK_SLOTS, D, F, M, extrapolate } from './sharedState.js';
import { DECK_META } from '../audio/deckMeta.js';
import { Params } from '../ui/params.js';
import { FX_PARAMS } from '../audio/paramMap.js';

/**
 * Stand-ins for Deck, SyncEngine, Engine and the app object, so the existing panels
 * run unchanged inside a window that has no AudioContext. Reads come from the shared
 * buffer, writes go out as commands.
 */

class RemoteDeck extends EventTarget {
  constructor(index, ctl) {
    super();
    this.index = index;
    this.ctl = ctl;
    this.label = DECK_META[index].label;
    this.color = DECK_META[index].color;
    this.base = index * DECK_SLOTS;
    this.analysis = null;
    this.analysisRev = -1;
    this.title = '';
    this.meta = {};
    this.assign = 'THRU';
  }

  get num() {
    return this.ctl.state.num;
  }
  get #flags() {
    return this.num[this.base + D.flags];
  }

  get playing() {
    return !!(this.#flags & F.playing);
  }
  get syncEnabled() {
    return !!(this.#flags & F.sync);
  }
  get keylock() {
    return !!(this.#flags & F.keylock);
  }
  get reverse() {
    return !!(this.#flags & F.reverse);
  }
  get cueOn() {
    return !!(this.#flags & F.cueOn);
  }
  get isSyncMaster() {
    return !!(this.#flags & F.syncMaster);
  }
  get loaded() {
    return !!(this.#flags & F.loaded);
  }
  get sourceMode() {
    return this.#flags & F.stream ? 'stream' : 'buffer';
  }

  get duration() {
    return this.num[this.base + D.duration];
  }
  get tempo() {
    return this.num[this.base + D.tempo] || 1;
  }
  get bpm() {
    return this.num[this.base + D.bpm];
  }
  get beatOffset() {
    return this.num[this.base + D.beatOffset];
  }
  get cuePoint() {
    return this.num[this.base + D.cuePoint];
  }
  get sampleRate() {
    return this.num[this.base + D.sampleRate] || 48000;
  }
  get effectiveBpm() {
    return this.bpm ? this.bpm * this.tempo : 0;
  }
  get pitchPercent() {
    return (this.tempo - 1) * 100;
  }

  get level() {
    const b = this.base;
    return { peakL: this.num[b + D.peakL], peakR: this.num[b + D.peakR], rms: this.num[b + D.rms] };
  }

  get loop() {
    const b = this.base;
    return {
      active: !!(this.#flags & F.loopActive),
      beats: this.num[b + D.loopBeats],
      start: this.num[b + D.loopStart],
      end: this.num[b + D.loopEnd]
    };
  }

  get hotCues() {
    const out = new Array(8);
    for (let i = 0; i < 8; i++) {
      const v = this.num[this.base + D.hotCue0 + i];
      out[i] = Number.isNaN(v) ? null : v;
    }
    return out;
  }

  positionSeconds() {
    return extrapolate(this.ctl.state, this.index, performance.now());
  }
  positionFrames() {
    return this.positionSeconds() * this.sampleRate;
  }
  currentRate() {
    return this.num[this.base + D.rate];
  }
  secondsPerBeat() {
    return this.bpm ? 60 / this.bpm : 0.5;
  }
  quantizeToBeat(seconds) {
    if (!this.bpm) return seconds;
    const spb = this.secondsPerBeat();
    return this.beatOffset + Math.round((seconds - this.beatOffset) / spb) * spb;
  }

  applyCold(cold) {
    this.title = cold.title ?? '';
    this.meta = cold.meta ?? {};
    if (cold.analysisRev !== undefined && cold.analysisRev !== this.analysisRev) {
      this.ctl.requestAnalysis(this.index);
    }
  }
}

for (const name of [
  'toggle',
  'play',
  'pause',
  'seekSeconds',
  'pressCue',
  'releaseCue',
  'setCuePointHere',
  'setHotCue',
  'jumpHotCue',
  'clearHotCue',
  'setTempo',
  'setPitchPercent',
  'setNudge',
  'setKeylock',
  'setReverse',
  'platterTouch',
  'scratch',
  'scratchEnd',
  'bend',
  'bendEnd',
  'setLoop',
  'scaleLoop',
  'exitLoop',
  'setCue'
]) {
  RemoteDeck.prototype[name] = function (...a) {
    this.ctl.command({ ns: 'deck', i: this.index, m: name, a });
  };
}

class RemoteSync {
  constructor(decks, ctl) {
    this.decks = decks;
    this.ctl = ctl;
  }
  get master() {
    return this.decks.find((d) => d.isSyncMaster) ?? null;
  }
  get masterIndex() {
    return this.master?.index ?? null;
  }
  toggleSync(deck) {
    this.ctl.command({ ns: 'sync', i: deck.index, m: 'toggleSync' });
  }
  disableSync(deck) {
    this.ctl.command({ ns: 'sync', i: deck.index, m: 'disableSync' });
  }
  setMaster(index) {
    this.ctl.command({ ns: 'sync', m: 'setMaster', a: [index] });
  }
  tick() {}
}

/** Enough of an AnalyserNode for the spectrum view, fed from the shared buffer. */
class RemoteAnalyser {
  constructor(state, sampleRate) {
    this.state = state;
    this.frequencyBinCount = state.spectrum.length;
    this.context = { sampleRate };
  }
  getByteFrequencyData(target) {
    target.set(this.state.spectrum.subarray(0, target.length));
  }
}

class RemoteEngine {
  constructor(ctl, cold) {
    this.ctl = ctl;
    this.ctx = { sampleRate: cold.sampleRate ?? 48000, currentTime: 0 };
    this.analyser = new RemoteAnalyser(ctl.state, this.ctx.sampleRate);
    this.units = Object.keys(FX_PARAMS).map((id) => ({
      id,
      setEnabled: (v) => ctl.params.set(`fx.${id}.on`, !!v),
      setAmount: (v) => ctl.params.set(`fx.${id}.amt`, v),
      setParam: (p, v) => ctl.params.set(`fx.${id}.${p}`, v)
    }));
  }

  setOutputMode(mode) {
    this.ctl.command({ ns: 'engine', m: 'setOutputMode', a: [mode] });
    return { mode };
  }
  async setCueDevice(id) {
    this.ctl.command({ ns: 'engine', m: 'setCueDevice', a: [id] });
  }
  setBeatTime(seconds) {
    this.ctl.command({ ns: 'engine', m: 'setBeatTime', a: [seconds] });
  }
  setMasterLevel() {}
  setCueMix() {}
  setPhonesLevel() {}
}

export class RemoteApp {
  constructor({ state, bus, cold }) {
    this.state = state;
    this.bus = bus;
    this.cold = cold;
    this.params = new Params(cold.params);
    this.params.onChange = (id, value) => bus.send('param', { id, value });

    this.decks = [0, 1, 2].map((i) => new RemoteDeck(i, this));
    this.sync = new RemoteSync(this.decks, this);
    this.engine = new RemoteEngine(this, cold);
    this.masterLevel = { peakL: 0, peakR: 0, rms: 0 };

    this.applyCold(cold);

    bus.on('cold', (next) => this.applyCold(next));
    bus.on('param', ({ id, value }) => this.params.set(id, value, true));
    bus.on('deck-event', ({ i, name, cold: deckCold }) => {
      const deck = this.decks[i];
      if (!deck) return;
      if (deckCold) deck.applyCold(deckCold);
      deck.dispatchEvent(new CustomEvent(name));
    });
    bus.on('analysis', ({ i, analysis, rev }) => {
      const deck = this.decks[i];
      if (!deck) return;
      deck.analysis = analysis;
      deck.analysisRev = rev;
      deck.dispatchEvent(new CustomEvent('analyzed'));
    });
    bus.on('toast', ({ message }) => this.toast(message));
  }

  applyCold(cold) {
    this.cold = { ...this.cold, ...cold };
    if (cold.params) this.params.merge(cold.params);
    for (const d of cold.decks ?? []) this.decks[d.index]?.applyCold(d);
  }

  command(msg) {
    this.bus.send('cmd', msg);
  }

  requestAnalysis(i) {
    this.bus.send('need', { what: 'analysis', i });
  }

  /** Drains the per-frame numbers that the panels cannot read directly. */
  tick() {
    this.masterLevel.peakL = this.state.num[M.peakL];
    this.masterLevel.peakR = this.state.num[M.peakR];
    this.masterLevel.rms = this.state.num[M.rms];
  }

  toast(message) {
    const el = document.querySelector('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  loadFile(deck, file) {
    file.arrayBuffer().then((bytes) => {
      this.command({ ns: 'app', i: deck.index, m: 'loadBlob', a: [new Blob([bytes]), file.name] });
    });
  }
  loadUrl(deck, url) {
    this.command({ ns: 'app', i: deck.index, m: 'loadUrl', a: [url] });
  }
  loadDemo(deck) {
    this.command({ ns: 'app', i: deck.index, m: 'loadDemo' });
  }
  loadSourceToDeck(deck, source) {
    this.command({ ns: 'app', i: deck.index, m: 'loadSource', a: [source] });
  }
  unlockDevices() {
    this.command({ ns: 'app', m: 'unlockDevices' });
  }
}
