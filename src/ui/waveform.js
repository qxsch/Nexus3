const BAND_PALETTE = (l, m, h) => {
  const t = l + m + h || 1;
  const r = (l * 34 + m * 20 + h * 255) / t;
  const g = (l * 118 + m * 232 + h * 250) / t;
  const b = (l * 255 + m * 196 + h * 255) / t;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
};

/** Overview strip (whole track) + scrolling detail view with beat grid. */
export class WaveformView {
  constructor({ overview, detail, deck, color }) {
    this.overviewCanvas = overview;
    this.detailCanvas = detail;
    this.deck = deck;
    this.color = color;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.secondsVisible = 6;
    this.cache = document.createElement('canvas');
    this.cacheValid = false;

    this.octx = overview.getContext('2d');
    this.dctx = detail.getContext('2d');

    this.resize();
    this.#bind();

    deck.addEventListener('analyzed', () => {
      this.cacheValid = false;
    });
    deck.addEventListener('loaded', () => {
      this.cacheValid = false;
    });
  }

  resize() {
    for (const c of [this.overviewCanvas, this.detailCanvas]) {
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * this.dpr));
      c.height = Math.max(1, Math.round(r.height * this.dpr));
    }
    this.cacheValid = false;
  }

  #bind() {
    const seekFromOverview = (e) => {
      if (!this.deck.duration) return;
      const r = this.overviewCanvas.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      this.deck.seekSeconds(frac * this.deck.duration);
    };
    let ovId = null;
    this.overviewCanvas.addEventListener('pointerdown', (e) => {
      if (ovId !== null) return;
      ovId = e.pointerId;
      this.overviewCanvas.setPointerCapture(e.pointerId);
      seekFromOverview(e);
    });
    this.overviewCanvas.addEventListener('pointermove', (e) => {
      if (e.pointerId === ovId) seekFromOverview(e);
    });
    const ovUp = (e) => {
      if (e.pointerId === ovId) ovId = null;
    };
    this.overviewCanvas.addEventListener('pointerup', ovUp);
    this.overviewCanvas.addEventListener('pointercancel', ovUp);

    let dragX = null;
    let dragStart = 0;
    let detailId = null;
    this.detailCanvas.addEventListener('pointerdown', (e) => {
      if (detailId !== null || !this.deck.duration) return;
      detailId = e.pointerId;
      dragX = e.clientX;
      dragStart = this.deck.positionSeconds();
      this.detailCanvas.setPointerCapture(e.pointerId);
    });
    this.detailCanvas.addEventListener('pointermove', (e) => {
      if (dragX == null || e.pointerId !== detailId) return;
      const r = this.detailCanvas.getBoundingClientRect();
      const pps = r.width / this.secondsVisible;
      this.deck.seekSeconds(dragStart - (e.clientX - dragX) / pps);
    });
    const dUp = (e) => {
      if (e.pointerId !== detailId) return;
      detailId = null;
      dragX = null;
    };
    this.detailCanvas.addEventListener('pointerup', dUp);
    this.detailCanvas.addEventListener('pointercancel', dUp);
    this.detailCanvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.secondsVisible = Math.max(1.5, Math.min(30, this.secondsVisible * (e.deltaY > 0 ? 1.15 : 0.87)));
      },
      { passive: false }
    );
  }

  #renderOverviewCache() {
    const a = this.deck.analysis;
    const w = this.overviewCanvas.width;
    const h = this.overviewCanvas.height;
    this.cache.width = w;
    this.cache.height = h;
    const g = this.cache.getContext('2d');
    g.clearRect(0, 0, w, h);
    if (!a) {
      this.cacheValid = true;
      return;
    }
    const n = a.min.length;
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((x / w) * n);
      const b1 = Math.max(b0 + 1, Math.floor(((x + 1) / w) * n));
      let mn = 1;
      let mx = -1;
      let l = 0;
      let m = 0;
      let hi = 0;
      for (let b = b0; b < b1 && b < n; b++) {
        if (a.min[b] < mn) mn = a.min[b];
        if (a.max[b] > mx) mx = a.max[b];
        l += a.low[b];
        m += a.mid[b];
        hi += a.high[b];
      }
      const cnt = Math.max(1, b1 - b0);
      if (mx < mn) continue;
      g.fillStyle = BAND_PALETTE(l / cnt, m / cnt, hi / cnt);
      const top = mid - mx * mid * 0.95;
      const bot = mid - mn * mid * 0.95;
      g.fillRect(x, top, 1, Math.max(1, bot - top));
    }
    this.cacheValid = true;
  }

  drawOverview() {
    const g = this.octx;
    const w = this.overviewCanvas.width;
    const h = this.overviewCanvas.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.025)';
    g.fillRect(0, 0, w, h);

    if (!this.cacheValid) this.#renderOverviewCache();
    if (this.deck.analysis) g.drawImage(this.cache, 0, 0);

    const dur = this.deck.duration;
    if (!dur) return;

    if (this.deck.loop.active) {
      g.fillStyle = 'rgba(255,214,10,0.22)';
      const x0 = (this.deck.loop.start / dur) * w;
      const x1 = (this.deck.loop.end / dur) * w;
      g.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    }

    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.fillRect((this.deck.cuePoint / dur) * w, 0, 2, h);

    this.deck.hotCues.forEach((c, i) => {
      if (c == null) return;
      g.fillStyle = ['#ff5f6d', '#ffd60a', '#4ade80', '#38bdf8', '#c084fc', '#fb923c', '#22d3ee', '#f472b6'][i];
      g.fillRect((c / dur) * w, 0, 2, h * 0.45);
    });

    const px = (this.deck.positionSeconds() / dur) * w;
    g.fillStyle = this.color;
    g.fillRect(px - 1, 0, 2, h);
  }

  drawDetail() {
    const g = this.dctx;
    const w = this.detailCanvas.width;
    const h = this.detailCanvas.height;
    const dpr = this.dpr;
    g.clearRect(0, 0, w, h);

    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, 'rgba(255,255,255,0.05)');
    bg.addColorStop(1, 'rgba(255,255,255,0.015)');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    const deck = this.deck;
    const a = deck.analysis;
    const pos = deck.positionSeconds();
    const pps = w / this.secondsVisible;
    const t0 = pos - this.secondsVisible / 2;
    const mid = h / 2;

    if (deck.loop.active) {
      const x0 = (deck.loop.start - t0) * pps;
      const x1 = (deck.loop.end - t0) * pps;
      g.fillStyle = 'rgba(255,214,10,0.16)';
      g.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    }

    if (deck.bpm) {
      const spb = deck.secondsPerBeat();
      let beat = Math.floor((t0 - deck.beatOffset) / spb);
      for (let t = deck.beatOffset + beat * spb; t < t0 + this.secondsVisible; t += spb, beat++) {
        const x = (t - t0) * pps;
        if (x < -2 || x > w + 2) continue;
        const isBar = ((beat % 4) + 4) % 4 === 0;
        g.fillStyle = isBar ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.13)';
        g.fillRect(x, isBar ? 0 : h * 0.14, isBar ? 2 * dpr : 1 * dpr, isBar ? h : h * 0.72);
      }
    }

    if (a) {
      const bs = a.bucketSize;
      const sr = deck.sampleRate;
      const n = a.min.length;
      for (let x = 0; x < w; x++) {
        const ta = t0 + x / pps;
        const tb = t0 + (x + 1) / pps;
        let b0 = Math.floor((ta * sr) / bs);
        let b1 = Math.max(b0 + 1, Math.floor((tb * sr) / bs));
        if (b1 <= 0 || b0 >= n) continue;
        b0 = Math.max(0, b0);
        b1 = Math.min(n, b1);
        let mn = 1;
        let mx = -1;
        let l = 0;
        let m = 0;
        let hi = 0;
        for (let b = b0; b < b1; b++) {
          if (a.min[b] < mn) mn = a.min[b];
          if (a.max[b] > mx) mx = a.max[b];
          l += a.low[b];
          m += a.mid[b];
          hi += a.high[b];
        }
        const cnt = Math.max(1, b1 - b0);
        if (mx < mn) continue;
        g.fillStyle = BAND_PALETTE(l / cnt, m / cnt, hi / cnt);
        const top = mid - mx * mid * 0.92;
        const bot = mid - mn * mid * 0.92;
        g.fillRect(x, top, 1, Math.max(1.5, bot - top));
      }
    }

    // centre playhead
    g.fillStyle = this.color;
    g.shadowColor = this.color;
    g.shadowBlur = 12;
    g.fillRect(w / 2 - 1, 0, 2 * dpr, h);
    g.shadowBlur = 0;
  }

  draw() {
    this.drawDetail();
    this.drawOverview();
  }
}
