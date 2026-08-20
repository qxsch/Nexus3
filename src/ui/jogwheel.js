const RPM = 100 / 3; // 33 1/3 rpm
const REV_SECONDS = 60 / RPM;

/** Canvas platter with vinyl-style scratching (inner area) and pitch bend (outer ring). */
export class JogWheel {
  constructor(canvas, deck, color) {
    this.canvas = canvas;
    this.deck = deck;
    this.color = color;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.angle = 0;
    this.scratching = false;
    this.bending = 0;
    this.rateSmooth = 0;
    this.lastMove = 0;
    this.resize();
    this.#bind();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const size = Math.max(120, Math.min(rect.width, rect.height) || rect.width);
    this.canvas.width = size * this.dpr;
    this.canvas.height = size * this.dpr;
    this.size = size;
  }

  #angleAt(e) {
    const r = this.canvas.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  }

  #radiusAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    return Math.hypot(dx, dy) / (r.width / 2);
  }

  #bind() {
    let lastAngle = 0;
    let lastTime = 0;
    let mode = null;
    let activeId = null;

    const down = (e) => {
      if (mode) return; // one finger owns the platter at a time
      const rad = this.#radiusAt(e);
      if (rad > 1.02) return;
      mode = rad > 0.8 ? 'bend' : 'scratch';
      activeId = e.pointerId;
      lastAngle = this.#angleAt(e);
      lastTime = performance.now();
      this.rateSmooth = this.deck.currentRate();
      this.canvas.setPointerCapture(e.pointerId);
      if (mode === 'scratch') {
        this.scratching = true;
        this.deck.platterTouch(true);
        this.deck.scratch(0);
      }
      e.preventDefault();
    };

    const move = (e) => {
      if (!mode || e.pointerId !== activeId) return;
      const a = this.#angleAt(e);
      const now = performance.now();
      let da = a - lastAngle;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const dt = Math.max(0.004, (now - lastTime) / 1000);
      lastAngle = a;
      lastTime = now;
      this.lastMove = now;

      if (mode === 'scratch') {
        const rate = (da / dt) * (REV_SECONDS / (2 * Math.PI));
        this.rateSmooth += (rate - this.rateSmooth) * 0.55;
        this.deck.scratch(Math.max(-12, Math.min(12, this.rateSmooth)));
      } else {
        const bend = Math.max(-0.3, Math.min(0.3, (da / dt) * 0.035));
        this.bending = bend;
        this.deck.bend(bend);
      }
    };

    const up = (e) => {
      if (!mode || e.pointerId !== activeId) return;
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {}
      if (mode === 'scratch') {
        this.deck.scratchEnd();
        this.deck.platterTouch(false);
        this.scratching = false;
      } else {
        this.deck.bendEnd();
        this.bending = 0;
      }
      mode = null;
      activeId = null;
    };

    this.canvas.addEventListener('pointerdown', down);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    this.canvas.addEventListener('pointerleave', (e) => {
      if (!this.canvas.hasPointerCapture?.(e.pointerId)) up(e);
    });

    // Holding still on the platter should brake, like a hand on vinyl.
    setInterval(() => {
      if (this.scratching && performance.now() - this.lastMove > 70) {
        this.rateSmooth *= 0.5;
        this.deck.scratch(this.rateSmooth);
      }
    }, 40);
  }

  draw(dt) {
    const deck = this.deck;
    const g = this.ctx;
    const s = this.size;
    const dpr = this.dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, s, s);

    const cx = s / 2;
    const cy = s / 2;
    const R = s / 2 - 2;

    this.angle += (deck.currentRate() * dt * 2 * Math.PI) / REV_SECONDS;

    // outer ring
    g.save();
    const ring = g.createLinearGradient(0, 0, s, s);
    ring.addColorStop(0, 'rgba(255,255,255,0.16)');
    ring.addColorStop(0.5, 'rgba(255,255,255,0.04)');
    ring.addColorStop(1, 'rgba(255,255,255,0.14)');
    g.beginPath();
    g.arc(cx, cy, R - 1, 0, Math.PI * 2);
    g.lineWidth = R * 0.17;
    g.strokeStyle = ring;
    g.stroke();
    g.restore();

    // progress arc
    const frac = deck.duration ? Math.min(1, deck.positionSeconds() / deck.duration) : 0;
    g.beginPath();
    g.arc(cx, cy, R - 1, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    g.lineWidth = R * 0.09;
    g.strokeStyle = this.color;
    g.globalAlpha = 0.85;
    g.lineCap = 'round';
    g.stroke();
    g.globalAlpha = 1;

    // platter body
    const plateR = R * 0.79;
    const body = g.createRadialGradient(cx - plateR * 0.3, cy - plateR * 0.35, plateR * 0.1, cx, cy, plateR);
    body.addColorStop(0, '#2a2d3a');
    body.addColorStop(0.55, '#15171f');
    body.addColorStop(1, '#0a0b10');
    g.beginPath();
    g.arc(cx, cy, plateR, 0, Math.PI * 2);
    g.fillStyle = body;
    g.fill();

    // grooves
    g.save();
    g.translate(cx, cy);
    g.rotate(this.angle);
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    g.lineWidth = 1;
    for (let r = plateR * 0.3; r < plateR; r += Math.max(3, plateR * 0.035)) {
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.stroke();
    }
    // rotating marker
    g.beginPath();
    g.moveTo(0, -plateR * 0.32);
    g.lineTo(0, -plateR * 0.96);
    g.strokeStyle = this.scratching ? '#ffffff' : this.color;
    g.lineWidth = Math.max(2, plateR * 0.035);
    g.lineCap = 'round';
    g.shadowColor = this.color;
    g.shadowBlur = this.scratching ? 18 : 10;
    g.stroke();
    g.shadowBlur = 0;
    // opposite dot for rotation feedback
    g.beginPath();
    g.arc(0, plateR * 0.62, plateR * 0.045, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.fill();
    g.restore();

    // label
    const labelR = plateR * 0.3;
    g.beginPath();
    g.arc(cx, cy, labelR, 0, Math.PI * 2);
    const lab = g.createRadialGradient(cx, cy, 2, cx, cy, labelR);
    lab.addColorStop(0, 'rgba(255,255,255,0.12)');
    lab.addColorStop(1, 'rgba(255,255,255,0.02)');
    g.fillStyle = lab;
    g.fill();
    g.strokeStyle = this.color;
    g.globalAlpha = 0.6;
    g.lineWidth = 1.5;
    g.stroke();
    g.globalAlpha = 1;

    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `600 ${Math.round(labelR * 0.52)}px ui-monospace, monospace`;
    g.fillText(deck.label, cx, cy - labelR * 0.18);
    g.font = `500 ${Math.round(labelR * 0.3)}px ui-monospace, monospace`;
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillText(deck.effectiveBpm ? deck.effectiveBpm.toFixed(1) : '--.-', cx, cy + labelR * 0.35);

    // spindle
    g.beginPath();
    g.arc(cx, cy, Math.max(2, labelR * 0.08), 0, Math.PI * 2);
    g.fillStyle = '#0a0b10';
    g.fill();
  }
}
