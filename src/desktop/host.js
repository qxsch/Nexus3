import { Bus, serveWelcome } from './bus.js';
import { createSharedState, DECK_SLOTS, D, F, M } from './sharedState.js';
import { panelById, PANEL_IDS } from './panels.js';
import { applyParam } from '../audio/paramMap.js';

const DECK_METHODS = new Set([
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
]);
const SYNC_METHODS = new Set(['toggleSync', 'disableSync', 'setMaster']);
const ENGINE_METHODS = new Set(['setOutputMode', 'setCueDevice', 'setBeatTime']);

/**
 * Console-window side of the multi-window layout: owns the audio graph, writes the
 * shared buffer every frame, answers panel windows and applies their commands.
 */
export class Host {
  constructor(app, { applyParam: applyParamFn } = {}) {
    this.app = app;
    this.applyParam = applyParamFn ?? ((id, value) => applyParam(app, id, value));
    this.state = createSharedState();
    this.bus = new Bus('console');
    this.windows = new Map();
    this.detached = new Set();
    this.wantsSpectrum = false;
    this.analysisRev = [0, 0, 0];
    this.cold = { ctxInfo: '', devices: [], scan: null };

    this.stopServing = serveWelcome(() => ({
      sab: this.state.buffer,
      cold: this.snapshot()
    }));

    this.bus.on('cmd', (msg) => this.#applyCommand(msg));
    this.bus.on('param', ({ id, value }) => {
      app.params.set(id, value, true);
      const applied = this.applyParam(id, value);
      if (applied !== undefined && applied !== value) this.bus.send('param', { id, value: applied });
    });
    this.bus.on('need', ({ what, i }) => {
      if (what === 'analysis') this.sendAnalysis(i);
      if (what === 'cold') this.bus.send('cold', this.snapshot());
    });
    this.bus.on('panel-open', ({ id }) => this.detached.add(id));

    for (const deck of app.decks) {
      for (const name of ['loaded', 'analyzed', 'ended']) {
        deck.addEventListener(name, () => {
          if (name === 'analyzed') this.analysisRev[deck.index]++;
          this.bus.send('deck-event', { i: deck.index, name, cold: this.#deckCold(deck) });
        });
      }
    }
  }

  // ------------------------------------------------------------- publishing

  #deckCold(deck) {
    return {
      index: deck.index,
      title: deck.title,
      meta: deck.meta,
      duration: deck.duration,
      bpm: deck.bpm,
      beatOffset: deck.beatOffset,
      sampleRate: deck.sampleRate,
      sourceMode: deck.sourceMode,
      loaded: deck.loaded,
      analysisRev: this.analysisRev[deck.index]
    };
  }

  snapshot() {
    const { app } = this;
    return {
      ...this.cold,
      masterIndex: app.sync?.masterIndex ?? null,
      decks: app.decks.map((d) => this.#deckCold(d)),
      params: app.params.snapshot()
    };
  }

  setCold(patch) {
    Object.assign(this.cold, patch);
    this.bus.send('cold', this.snapshot());
  }

  sendAnalysis(i) {
    const deck = this.app.decks[i];
    if (!deck?.analysis) return;
    this.bus.send('analysis', { i, analysis: deck.analysis, rev: this.analysisRev[i] });
  }

  toast(message) {
    this.bus.send('toast', { message });
  }

  /** Called once per animation frame from the console render loop. */
  publish(nowMs) {
    if (!this.detached.size) return;
    const { num, spectrum, gen } = this.state;
    const { app } = this;

    for (const deck of app.decks) {
      const b = deck.index * DECK_SLOTS;
      num[b + D.position] = deck.positionSeconds();
      num[b + D.rate] = deck.currentRate();
      num[b + D.duration] = deck.duration;
      num[b + D.tempo] = deck.tempo;
      num[b + D.bpm] = deck.bpm;
      num[b + D.beatOffset] = deck.beatOffset;
      num[b + D.cuePoint] = deck.cuePoint;
      num[b + D.loopStart] = deck.loop.start;
      num[b + D.loopEnd] = deck.loop.end;
      num[b + D.loopBeats] = deck.loop.beats;
      num[b + D.peakL] = deck.level?.peakL ?? 0;
      num[b + D.peakR] = deck.level?.peakR ?? 0;
      num[b + D.rms] = deck.level?.rms ?? 0;
      num[b + D.sampleRate] = deck.sampleRate;
      num[b + D.hostTime] = nowMs;
      num[b + D.analysisRev] = this.analysisRev[deck.index];
      for (let h = 0; h < 8; h++) num[b + D.hotCue0 + h] = deck.hotCues[h] ?? NaN;

      let flags = 0;
      if (deck.playing) flags |= F.playing;
      if (deck.syncEnabled) flags |= F.sync;
      if (deck.keylock) flags |= F.keylock;
      if (deck.reverse) flags |= F.reverse;
      if (deck.cueOn) flags |= F.cueOn;
      if (deck.loop.active) flags |= F.loopActive;
      if (deck.sourceMode === 'stream') flags |= F.stream;
      if (deck.loaded) flags |= F.loaded;
      if (app.sync?.master === deck) flags |= F.syncMaster;
      num[b + D.flags] = flags;
    }

    num[M.ctxTime] = app.engine.ctx?.currentTime ?? 0;
    num[M.hostTime] = nowMs;
    num[M.ready] = 1;
    if (app.masterLevel) {
      num[M.peakL] = app.masterLevel.peakL ?? 0;
      num[M.peakR] = app.masterLevel.peakR ?? 0;
      num[M.rms] = app.masterLevel.rms ?? 0;
    }
    if (this.wantsSpectrum && app.engine.analyser) {
      app.engine.analyser.getByteFrequencyData(this.spectrumScratch ??= new Uint8Array(app.engine.analyser.frequencyBinCount));
      spectrum.set(this.spectrumScratch.subarray(0, spectrum.length));
    }

    Atomics.add(gen, 0, 1);
  }

  // -------------------------------------------------------------- commands

  #applyCommand({ ns, i, m, a = [] }) {
    const { app } = this;
    try {
      if (ns === 'deck' && DECK_METHODS.has(m)) return void app.decks[i]?.[m](...a);
      if (ns === 'sync' && SYNC_METHODS.has(m)) {
        if (m === 'setMaster') return void app.sync.setMaster(a[0]);
        return void app.sync[m](app.decks[i]);
      }
      if (ns === 'engine' && ENGINE_METHODS.has(m)) return void app.engine[m](...a);
      if (ns === 'app') {
        if (m === 'loadDemo') return void app.loadDemo(app.decks[i]);
        if (m === 'loadUrl') return void app.loadUrl(app.decks[i], a[0]);
        if (m === 'loadSource') return void app.loadSourceToDeck(app.decks[i], a[0]);
        if (m === 'loadBlob') return void app.loadFile(app.decks[i], new File([a[0]], a[1] ?? 'track'));
        if (m === 'rescan') return void app.crate?.refreshTree();
        if (m === 'unlockDevices') return void app.unlockDevices?.();
      }
    } catch (err) {
      console.warn(`remote command ${ns}.${m} failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------- windows

  /** Opens or closes panel windows so the live set matches `ids`. */
  reconcile(ids) {
    const wanted = new Set(ids.filter((id) => PANEL_IDS.includes(id)));

    for (const [id, win] of this.windows) {
      if (!wanted.has(id) || win.closed) {
        if (!win.closed) win.close();
        this.windows.delete(id);
      }
    }
    for (const id of wanted) {
      if (this.windows.has(id)) continue;
      const meta = panelById(id);
      const win = window.open(
        `${location.origin}/?panel=${id}`,
        `nx3-${id}`,
        `width=${meta.minWidth},height=${meta.minHeight}`
      );
      if (win) this.windows.set(id, win);
    }

    this.detached = wanted;
    this.wantsSpectrum = wanted.has('master');
    return [...wanted];
  }

  closeAll() {
    for (const [, win] of this.windows) if (!win.closed) win.close();
    this.windows.clear();
    this.detached.clear();
  }
}
