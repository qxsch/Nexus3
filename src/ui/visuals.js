export class Spectrum {
  constructor(canvas, analyser, colors) {
    this.canvas = canvas;
    this.analyser = analyser;
    this.colors = colors;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.data = new Uint8Array(analyser.frequencyBinCount);
    this.smooth = new Float32Array(72);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
  }

  draw() {
    const g = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    g.clearRect(0, 0, w, h);
    this.analyser.getByteFrequencyData(this.data);

    const bars = this.smooth.length;
    const nyquist = this.analyser.context.sampleRate / 2;
    const minF = 28;
    const maxF = 17000;
    const bw = w / bars;

    for (let i = 0; i < bars; i++) {
      const f0 = minF * Math.pow(maxF / minF, i / bars);
      const f1 = minF * Math.pow(maxF / minF, (i + 1) / bars);
      let b0 = Math.floor((f0 / nyquist) * this.data.length);
      let b1 = Math.max(b0 + 1, Math.floor((f1 / nyquist) * this.data.length));
      b1 = Math.min(this.data.length, b1);
      let peak = 0;
      for (let b = b0; b < b1; b++) if (this.data[b] > peak) peak = this.data[b];
      const v = peak / 255;
      this.smooth[i] += (v - this.smooth[i]) * (v > this.smooth[i] ? 0.55 : 0.12);

      const bh = Math.pow(this.smooth[i], 1.25) * h;
      const x = i * bw;
      const grad = g.createLinearGradient(0, h, 0, h - bh);
      grad.addColorStop(0, this.colors[0]);
      grad.addColorStop(0.6, this.colors[1]);
      grad.addColorStop(1, this.colors[2]);
      g.fillStyle = grad;
      g.fillRect(x + bw * 0.12, h - bh, bw * 0.76, bh);
    }
  }
}

const DB_MIN = -48;
const DB_MAX = 4;

function toFrac(amp) {
  if (amp <= 0) return 0;
  const db = 20 * Math.log10(amp);
  return Math.max(0, Math.min(1, (db - DB_MIN) / (DB_MAX - DB_MIN)));
}

/** Segmented stereo peak meter with peak hold. */
export class Meter {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.hold = [0, 0];
    this.holdAt = [0, 0];
    this.value = [0, 0];
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
  }

  draw(level) {
    const g = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    g.clearRect(0, 0, w, h);

    const targets = [toFrac(level?.peakL ?? 0), toFrac(level?.peakR ?? 0)];
    const now = performance.now();
    const segs = 26;
    const gap = Math.max(1, h * 0.004);
    const sh = (h - gap * (segs - 1)) / segs;
    const cw = (w - 3) / 2;

    for (let c = 0; c < 2; c++) {
      const target = targets[c];
      this.value[c] += (target - this.value[c]) * (target > this.value[c] ? 0.8 : 0.14);
      if (target >= this.hold[c]) {
        this.hold[c] = target;
        this.holdAt[c] = now;
      } else if (now - this.holdAt[c] > 900) {
        this.hold[c] = Math.max(target, this.hold[c] - 0.012);
      }

      const lit = Math.round(this.value[c] * segs);
      for (let s = 0; s < segs; s++) {
        const y = h - (s + 1) * sh - s * gap;
        const on = s < lit;
        const ratio = s / segs;
        let color;
        if (ratio > 0.9) color = on ? '#ff3b30' : 'rgba(255,59,48,0.13)';
        else if (ratio > 0.76) color = on ? '#ffd60a' : 'rgba(255,214,10,0.12)';
        else color = on ? '#3ddc97' : 'rgba(61,220,151,0.1)';
        g.fillStyle = color;
        g.fillRect(c * (cw + 3), y, cw, sh);
      }
      const hy = h - this.hold[c] * h;
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillRect(c * (cw + 3), Math.max(0, hy - 1), cw, Math.max(1, sh * 0.25));
    }
  }
}
