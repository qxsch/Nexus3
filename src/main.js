import { Engine } from './audio/engine.js';
import { Deck } from './audio/deck.js';
import { SyncEngine } from './audio/sync.js';
import { renderDemoTrack } from './audio/demo.js';
import { DECK_META } from './audio/deckMeta.js';
import { applyAllParams, applyParam, defaultParams } from './audio/paramMap.js';
import { DeckPanel } from './ui/deckPanel.js';
import { buildChannels, buildFxRack, buildMaster } from './ui/mixerPanel.js';
import { CratePanel } from './ui/cratePanel.js';
import { ScanStatus } from './ui/scanStatus.js';
import { buildHeader } from './ui/headerPanel.js';
import { Params } from './ui/params.js';
import { wireKeyboard } from './ui/shortcuts.js';
import { loadSource } from './services/trackLoader.js';
import { jamendo } from './services/jamendo.js';
import { Host } from './desktop/host.js';
import { PANEL_IDS, panelById } from './desktop/panels.js';

const FILE_URL = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm)(\?.*)?$/i;
const ROUTING_IDS = ['out.mode', 'out.master', 'out.device'];
const ROUTING_STORAGE = 'nx3.routing';

const $ = (sel) => document.querySelector(sel);
const toastEl = $('#toast');
let toastTimer = 0;

const disabledHost = {
  bus: { send() {} },
  publish() {},
  reconcile() {},
  setCold() {}
};

function toast(message, ms = 3200) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

const app = {
  engine: new Engine(),
  decks: [],
  panels: [],
  sync: null,
  crate: null,
  host: null,
  params: new Params(defaultParams()),
  masterLevel: { peakL: 0, peakR: 0, rms: 0 },
  toast,

  async loadSourceToDeck(deck, source) {
    const panel = this.panels[deck.index];
    panel?.setProgress({ phase: 'download', loaded: 0, total: 0 });
    try {
      const { title } = await loadSource(this.engine.ctx, deck, source, (p) => panel?.setProgress(p));
      toast(`Deck ${deck.label}: ${title}${deck.bpm ? ` · ${deck.bpm.toFixed(2)} BPM` : ''}`);
    } catch (err) {
      console.error(err);
      toast(`Deck ${deck.label}: ${err.message}`);
    } finally {
      panel?.setProgress(null);
    }
  },

  loadFile(deck, file) {
    return this.loadSourceToDeck(deck, { kind: 'file', file });
  },

  async loadUrl(deck, url) {
    if (FILE_URL.test(url)) return this.loadSourceToDeck(deck, { kind: 'url', url });
    const panel = this.panels[deck.index];
    panel?.setProgress({ phase: 'download', loaded: 0, total: 0 });
    try {
      await deck.loadStream(url, decodeURIComponent(url.split('/').pop() || url));
      toast(`Deck ${deck.label}: live stream mode, scratching is unavailable.`);
    } catch (err) {
      toast(`Deck ${deck.label}: ${err.message}`);
    } finally {
      panel?.setProgress(null);
    }
  },

  async loadDemo(deck) {
    const panel = this.panels[deck.index];
    panel?.setBusy(true);
    try {
      const meta = DECK_META[deck.index].demo;
      const audio = await renderDemoTrack({
        sampleRate: this.engine.ctx.sampleRate,
        bpm: meta.bpm,
        style: meta.style
      });
      await deck.load(audio, `Demo ${meta.style} ${meta.bpm}`);
      toast(`Deck ${deck.label}: demo rendered · detected ${deck.bpm.toFixed(2)} BPM (actual ${meta.bpm})`);
    } catch (err) {
      console.error(err);
      toast(`Deck ${deck.label}: demo render failed, ${err.message}`);
    } finally {
      panel?.setBusy(false);
    }
  }
};

// ------------------------------------------------------------------- layout

const SLOTS = {
  deckA: '#decks',
  deckB: '#decks',
  deckC: '#decks',
  crate: '#crate',
  fx: '#mixer',
  channels: '#mixer',
  master: '#mixer'
};

const sections = new Map();
let detached = new Set();

function buildSection(id, host) {
  const meta = panelById(id);
  if (meta.deck !== undefined) {
    const panel = new DeckPanel(app.decks[meta.deck], app);
    app.panels[meta.deck] = panel;
    return { el: panel.el, update: (now) => panel.update(now), resize: () => panel.resize() };
  }
  if (id === 'crate') {
    app.crate = new CratePanel(host, app);
    return { update() {}, resize() {} };
  }
  return { fx: buildFxRack, channels: buildChannels, master: buildMaster }[id](app);
}

function placeholder(id) {
  const el = document.createElement('div');
  el.className = 'panel detached-note';
  el.innerHTML = `<b>${panelById(id).title}</b><span>open in its own window</span>`;
  return el;
}

/** Rebuilds the console layout so it holds exactly the panels that are not detached. */
function applyLayout(ids = []) {
  detached = new Set(ids.filter((id) => PANEL_IDS.includes(id)));
  if (!app.decks.length) return;

  for (const host of new Set(Object.values(SLOTS))) document.querySelector(host).innerHTML = '';
  sections.clear();
  app.panels = [];
  if (detached.has('crate')) app.crate = null;

  for (const id of PANEL_IDS) {
    const host = document.querySelector(SLOTS[id]);
    if (detached.has(id)) {
      host.appendChild(placeholder(id));
      continue;
    }
    const section = buildSection(id, host);
    if (section.el) host.appendChild(section.el);
    sections.set(id, section);
  }

  document.body.classList.toggle('multi-window', detached.size > 0);
  app.host?.reconcile([...detached]);
  requestAnimationFrame(() => {
    for (const s of sections.values()) s.resize?.();
  });
}

function startRenderLoop() {
  let lastSync = 0;
  const frame = (now) => {
    for (const s of sections.values()) s.update(now);
    if (now - lastSync > 55) {
      lastSync = now;
      app.sync.tick();
      const master = app.sync.master;
      if (master?.effectiveBpm) app.engine.setBeatTime(60 / master.effectiveBpm);
    }
    app.host.publish(now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function boot() {
  const btn = $('#boot-btn');
  btn.disabled = true;
  btn.textContent = 'Starting audio engine…';

  const ctx = await app.engine.init();
  await app.engine.resume();

  app.decks = DECK_META.map((meta, i) => new Deck(app.engine, i, meta));
  app.sync = new SyncEngine(app.decks);
  app.engine.createMeter(app.engine.limiter, (level) => (app.masterLevel = level));
  applyAllParams(app);

  await jamendo.init().catch(() => {});

  app.host = globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'
    ? new Host(app, { applyParam: applyParamWithFallback })
    : disabledHost;
  app.host.setCold({ sampleRate: ctx.sampleRate });
  app.host.bus.send('host-ready', {});
  app.params.onChange = (id, value) => {
    const applied = applyParamWithFallback(id, value);
    app.host.bus.send('param', { id, value: applied });
    if (ROUTING_IDS.includes(id)) saveRouting();
  };

  app.scan = new ScanStatus($('#scan-host'), () => {
    app.crate?.refreshTree();
    app.host.bus.send('refresh-crate', {});
  });

  // Routing stays in the console window, so it is built once and never moves.
  restoreRouting();
  $('#routing-host').replaceChildren(buildHeader(app));
  applyLayout([...detached]);

  $('#ctx-info').textContent =
    `${(ctx.sampleRate / 1000).toFixed(1)} kHz · ${(ctx.baseLatency * 1000).toFixed(1)} ms buffer · worklets live`;

  wireKeyboard(app);
  startRenderLoop();

  $('#boot').classList.add('hidden');
  $('#boot').classList.remove('retry');
  toast('Browse the crate above, drag a track onto a deck, or hit Demo for instant sound.', 5200);
}

/** Split 4-channel silently falls back when the device has only two outputs. */
function applyParamWithFallback(id, value) {
  const res = applyParam(app, id, value);
  if (id === 'out.mode' && res && res.mode !== value) {
    app.params.set('out.mode', res.mode, true);
    toast('This output device does not expose 4 channels — using the second-device route instead.');
    return res.mode;
  }
  if (id === 'out.mode' && value === 'split4') toast('Master on outputs 1/2, headphone cue on outputs 3/4.');
  return value;
}

/** Device choices are per machine, so they live next to the browser profile rather than in config.json. */
function restoreRouting() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(ROUTING_STORAGE) ?? '{}');
  } catch {}
  for (const id of ROUTING_IDS) {
    if (typeof saved[id] === 'string') app.params.set(id, saved[id], true);
    applyParam(app, id, app.params.get(id));
  }
}

function saveRouting() {
  try {
    localStorage.setItem(
      ROUTING_STORAGE,
      JSON.stringify(Object.fromEntries(ROUTING_IDS.map((id) => [id, app.params.get(id, '')])))
    );
  } catch {}
}

function wireConsole() {
  const startBoot = () =>
    boot().catch((err) => {
      console.error(err);
      const btn = $('#boot-btn');
      btn.disabled = false;
      btn.textContent = 'Retry';
      // Bring the card back, since the desktop stylesheet keeps it hidden.
      $('#boot').classList.add('retry');
      $('#boot').classList.remove('hidden');
      toast(`Audio engine failed to start: ${err.message}`, 6000);
    });

  $('#boot-btn').addEventListener('click', startBoot);

  $('#help-btn').addEventListener('click', () => $('#help').classList.toggle('hidden'));
  $('#help-close').addEventListener('click', () => $('#help').classList.add('hidden'));
  $('#help').addEventListener('click', (e) => {
    if (e.target === $('#help')) $('#help').classList.add('hidden');
  });

  // The desktop shell owns the layout: it tells us which boxes live in their own window.
  window.nexus?.onLayout?.(({ detached: ids }) => applyLayout(ids ?? []));

  // The desktop app relaxes the autoplay policy, so there is no gesture to wait for.
  if (window.nexus?.desktop) startBoot();

  let resizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const s of sections.values()) s.resize?.();
    }, 120);
  });
}

const panelParam = new URLSearchParams(location.search).get('panel');
if (panelParam) {
  import('./desktop/panelMain.js').then((m) => m.startPanel(panelParam));
} else {
  wireConsole();
}
