import { Fader, segButton } from './controls.js';
import { JogWheel } from './jogwheel.js';
import { WaveformView } from './waveform.js';

const PAD_COLORS = ['#ff5f6d', '#ffd60a', '#4ade80', '#38bdf8'];
const LOOP_SIZES = [1, 2, 4, 8];

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export class DeckPanel {
  constructor(deck, app) {
    this.deck = deck;
    this.app = app;
    this.range = 0.16;
    this.lastFrame = performance.now();

    const el = document.createElement('article');
    el.className = 'deck';
    el.style.setProperty('--deck-color', deck.color);
    el.innerHTML = `
      <div class="deck-top">
        <span class="deck-badge">${deck.label}</span>
        <div class="deck-title">
          <div class="track-name">No track loaded</div>
          <div class="track-meta"><span class="t-pos">0:00</span> / <span class="t-dur">0:00</span> · <span class="t-state">idle</span><a class="t-lic" target="_blank" rel="noreferrer"></a></div>
        </div>
        <div class="deck-bpm">
          <b class="bpm">--.-</b>
          <small>BPM</small>
          <i class="pitch">0.00%</i>
        </div>
      </div>

      <div class="loader">
        <button class="js-file" type="button">File</button>
        <input class="js-url" type="url" placeholder="https://… .mp3 or stream" spellcheck="false" />
        <button class="js-load" type="button">Load</button>
        <button class="js-demo" type="button">Demo</button>
        <input class="js-file-input" type="file" accept="audio/*" hidden />
      </div>

      <div class="deck-progress js-progress hidden"><i></i><b></b></div>

      <canvas class="wave-detail"></canvas>
      <canvas class="wave-overview"></canvas>

      <div class="deck-main">
        <canvas class="jog"></canvas>
        <div class="deck-side">
          <div class="js-pitch"></div>
          <div class="seg js-range"></div>
          <div class="mini-row">
            <button class="js-sync" type="button">SYNC</button>
            <button class="js-master" type="button">MST</button>
          </div>
        </div>
      </div>

      <div class="transport">
        <button class="cue js-cue" type="button">CUE</button>
        <button class="play js-play" type="button">PLAY</button>
        <button class="js-rev" type="button">REV</button>
        <button class="js-key" type="button">KEY</button>
      </div>

      <div class="pads js-hotcues"></div>
      <div class="pads js-loops"></div>`;

    this.el = el;
    this.$ = (s) => el.querySelector(s);
    this.name = this.$('.track-name');
    this.tPos = this.$('.t-pos');
    this.tDur = this.$('.t-dur');
    this.tState = this.$('.t-state');
    this.bpmEl = this.$('.bpm');
    this.pitchEl = this.$('.pitch');
    this.licEl = this.$('.t-lic');
    this.progressEl = this.$('.js-progress');
    this.progressFill = this.progressEl.querySelector('i');
    this.progressText = this.progressEl.querySelector('b');
    this.playBtn = this.$('.js-play');
    this.cueBtn = this.$('.js-cue');
    this.syncBtn = this.$('.js-sync');
    this.masterBtn = this.$('.js-master');
    this.keyBtn = this.$('.js-key');
    this.revBtn = this.$('.js-rev');

    this.#buildControls();
    this.#buildPads();
    this.#bind();

    this.jog = new JogWheel(this.$('.jog'), deck, deck.color);
    this.wave = new WaveformView({
      overview: this.$('.wave-overview'),
      detail: this.$('.wave-detail'),
      deck,
      color: deck.color
    });
  }

  #buildControls() {
    const deck = this.deck;

    this.pitch = new Fader({
      min: -1,
      max: 1,
      default: 0,
      vertical: true,
      ticks: 10,
      label: `Deck ${deck.label} pitch`,
      color: deck.color,
      format: (v) => `${(v * this.range * 100 >= 0 ? '+' : '') + (v * this.range * 100).toFixed(2)}%`,
      onChange: (v) => {
        if (deck.syncEnabled) this.app.sync.disableSync(deck);
        deck.setPitchPercent(v * this.range * 100);
      }
    });
    this.$('.js-pitch').appendChild(this.pitch.el);

    this.rangeSeg = segButton(
      [
        { label: '±8', value: '0.08' },
        { label: '±16', value: '0.16' },
        { label: '±50', value: '0.5' }
      ],
      '0.16',
      (v) => {
        this.range = Number(v);
        this.pitch.set(this.pitch.value);
      }
    );
    this.$('.js-range').replaceWith(this.rangeSeg.el);
    this.rangeSeg.el.style.setProperty('--deck-color', deck.color);
  }

  #buildPads() {
    const hot = this.$('.js-hotcues');
    this.hotPads = LOOP_SIZES.map((_, i) => {
      const b = document.createElement('button');
      b.className = 'pad';
      b.type = 'button';
      b.textContent = `CUE ${i + 1}`;
      b.style.setProperty('--pad-color', PAD_COLORS[i]);
      b.addEventListener('click', (e) => {
        if (e.shiftKey) this.deck.clearHotCue(i);
        else this.deck.jumpHotCue(i);
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.deck.clearHotCue(i);
      });
      hot.appendChild(b);
      return b;
    });

    const loops = this.$('.js-loops');
    this.loopPads = LOOP_SIZES.map((n) => {
      const b = document.createElement('button');
      b.className = 'pad loop';
      b.type = 'button';
      b.textContent = `${n} BT`;
      b.addEventListener('click', () => {
        const d = this.deck;
        if (d.loop.active && d.loop.beats === n) d.exitLoop();
        else d.setLoop(n);
      });
      loops.appendChild(b);
      return b;
    });
  }

  #bind() {
    const deck = this.deck;
    const app = this.app;

    const fileInput = this.$('.js-file-input');
    this.$('.js-file').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.[0]) app.loadFile(deck, fileInput.files[0]);
    });

    const urlInput = this.$('.js-url');
    const loadUrl = () => {
      const url = urlInput.value.trim();
      if (url) app.loadUrl(deck, url);
    };
    this.$('.js-load').addEventListener('click', loadUrl);
    urlInput.addEventListener('keydown', (e) => e.key === 'Enter' && loadUrl());
    this.$('.js-demo').addEventListener('click', () => app.loadDemo(deck));

    this.playBtn.addEventListener('click', () => deck.toggle());
    this.cueBtn.addEventListener('pointerdown', () => {
      deck.pressCue();
      this.cueBtn.classList.add('held');
    });
    const cueUp = () => {
      deck.releaseCue();
      this.cueBtn.classList.remove('held');
    };
    this.cueBtn.addEventListener('pointerup', cueUp);
    this.cueBtn.addEventListener('pointerleave', cueUp);
    this.cueBtn.addEventListener('pointercancel', cueUp);

    this.syncBtn.addEventListener('click', () => {
      app.sync.toggleSync(deck);
      if (deck.syncEnabled) this.pitch.set((deck.tempo - 1) / this.range, false);
    });
    this.masterBtn.addEventListener('click', () => {
      app.sync.setMaster(app.sync.masterIndex === deck.index ? null : deck.index);
    });
    this.keyBtn.addEventListener('click', () => deck.setKeylock(!deck.keylock));
    this.revBtn.addEventListener('click', () => deck.setReverse(!deck.reverse));

    this.el.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.el.classList.add('dragover');
    });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('dragover'));
    this.el.addEventListener('drop', (e) => {
      e.preventDefault();
      this.el.classList.remove('dragover');
      const encoded = e.dataTransfer?.getData('application/x-nx3-source');
      if (encoded) {
        try {
          app.loadSourceToDeck(deck, JSON.parse(encoded));
          return;
        } catch {}
      }
      const f = e.dataTransfer?.files?.[0];
      if (f) app.loadFile(deck, f);
    });

    deck.addEventListener('loaded', () => {
      const artist = deck.meta?.artist;
      this.name.textContent = artist ? `${artist} \u2013 ${deck.title}` : deck.title || 'Untitled';
      if (deck.meta?.pageUrl) {
        const parts = [deck.meta.provider, deck.meta.license].filter(Boolean);
        this.licEl.textContent = ` \u00b7 ${parts.join(' \u00b7 ')}`;
        this.licEl.href = deck.meta.pageUrl;
      } else {
        this.licEl.textContent = '';
        this.licEl.removeAttribute('href');
      }
    });
    deck.addEventListener('analyzed', () => this.el.classList.remove('busy'));
  }

  setProgress(info) {
    if (!info) {
      this.progressEl.classList.add('hidden');
      this.el.classList.remove('busy');
      return;
    }
    this.progressEl.classList.remove('hidden');
    this.el.classList.add('busy');
    let pct = 100;
    let text = 'ready';
    if (info.phase === 'download') {
      pct = info.total ? (info.loaded / info.total) * 100 : 6;
      text = info.cached
        ? 'from cache'
        : info.total
          ? `buffering ${(info.loaded / 1048576).toFixed(1)} / ${(info.total / 1048576).toFixed(1)} MB`
          : 'buffering';
    } else if (info.phase === 'decode') {
      text = 'decoding';
    } else if (info.phase === 'analyse') {
      text = 'analysing beat grid';
    }
    this.progressFill.style.width = `${Math.max(2, Math.min(100, pct))}%`;
    this.progressText.textContent = text;
  }

  setBusy(on) {
    this.el.classList.toggle('busy', on);
  }

  update(now) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const deck = this.deck;

    this.tPos.textContent = fmtTime(deck.positionSeconds());
    this.tDur.textContent = fmtTime(deck.duration);
    this.bpmEl.textContent = deck.effectiveBpm ? deck.effectiveBpm.toFixed(2) : '--.-';
    const p = (deck.tempo - 1) * 100;
    this.pitchEl.textContent = `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
    this.tState.textContent = deck.sourceMode === 'stream' ? 'stream' : deck.playing ? 'playing' : 'cued';

    this.playBtn.classList.toggle('on', deck.playing);
    this.syncBtn.classList.toggle('on', deck.syncEnabled);
    this.masterBtn.classList.toggle('on', this.app.sync.master === deck);
    this.keyBtn.classList.toggle('on', deck.keylock);
    this.revBtn.classList.toggle('on', deck.reverse);
    this.el.classList.toggle('playing', deck.playing);

    this.hotPads.forEach((b, i) => b.classList.toggle('set', deck.hotCues[i] != null));
    this.loopPads.forEach((b, i) =>
      b.classList.toggle('on', deck.loop.active && deck.loop.beats === LOOP_SIZES[i])
    );

    if (deck.syncEnabled) {
      const needed = Math.abs(deck.tempo - 1);
      if (needed > this.range) {
        const next = [0.08, 0.16, 0.5].find((r) => r >= needed) ?? 0.5;
        if (next !== this.range) {
          this.range = next;
          this.rangeSeg.set(String(next));
        }
      }
      const want = (deck.tempo - 1) / this.range;
      if (Math.abs(want - this.pitch.value) > 0.002) this.pitch.set(want, false);
    }

    this.jog.draw(dt);
    this.wave.draw();
  }

  resize() {
    this.jog.resize();
    this.wave.resize();
  }
}
