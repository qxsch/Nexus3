const SWEEP = 270;
const R = 16;
const C = 2 * Math.PI * R;

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export class Knob {
  constructor(opts) {
    this.min = opts.min ?? 0;
    this.max = opts.max ?? 1;
    this.default = opts.default ?? opts.value ?? this.min;
    this.value = opts.value ?? this.default;
    this.bipolar = !!opts.bipolar;
    this.step = opts.step ?? (this.max - this.min) / 100;
    this.format = opts.format ?? ((v) => v.toFixed(1));
    this.onChange = opts.onChange ?? (() => {});
    this.size = opts.size ?? 46;

    const el = document.createElement('div');
    el.className = 'knob' + (opts.className ? ' ' + opts.className : '');
    el.style.setProperty('--knob-size', this.size + 'px');
    el.innerHTML = `
      <div class="knob-dial" tabindex="0" role="slider"
           aria-valuemin="${this.min}" aria-valuemax="${this.max}" aria-label="${opts.label ?? ''}">
        <svg viewBox="0 0 40 40" aria-hidden="true">
          <circle class="knob-track" cx="20" cy="20" r="${R}"></circle>
          <circle class="knob-value" cx="20" cy="20" r="${R}"></circle>
        </svg>
        <span class="knob-pointer"></span>
      </div>
      <span class="knob-label">${opts.label ?? ''}</span>
      <span class="knob-readout"></span>`;

    this.el = el;
    this.dial = el.querySelector('.knob-dial');
    this.arc = el.querySelector('.knob-value');
    this.pointer = el.querySelector('.knob-pointer');
    this.readout = el.querySelector('.knob-readout');
    if (opts.color) el.style.setProperty('--knob-color', opts.color);

    this.#bind();
    this.set(this.value, false);
  }

  #bind() {
    let startY = 0;
    let startVal = 0;
    let activeId = null;

    this.dial.addEventListener('pointerdown', (e) => {
      if (activeId !== null) return; // a second finger must not hijack this knob
      activeId = e.pointerId;
      startY = e.clientY;
      startVal = this.value;
      try {
        this.dial.setPointerCapture(e.pointerId);
      } catch {}
      this.el.classList.add('active');
      e.preventDefault();
    });
    this.dial.addEventListener('pointermove', (e) => {
      if (e.pointerId !== activeId) return;
      const fine = e.shiftKey ? 4 : 1;
      const span = this.max - this.min;
      this.set(startVal + ((startY - e.clientY) / (170 * fine)) * span);
    });
    const end = (e) => {
      if (e.pointerId !== activeId) return;
      activeId = null;
      try {
        this.dial.releasePointerCapture(e.pointerId);
      } catch {}
      this.el.classList.remove('active');
    };
    this.dial.addEventListener('pointerup', end);
    this.dial.addEventListener('pointercancel', end);
    this.dial.addEventListener('dblclick', () => this.set(this.default));
    this.dial.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.set(this.value - Math.sign(e.deltaY) * this.step * (e.shiftKey ? 0.25 : 2));
      },
      { passive: false }
    );
    this.dial.addEventListener('keydown', (e) => {
      const k = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!k) return;
      e.preventDefault();
      this.set(this.value + k * this.step * 2);
    });
  }

  set(v, notify = true) {
    this.value = clamp(v, this.min, this.max);
    const frac = (this.value - this.min) / (this.max - this.min);
    const zero = this.bipolar ? (this.default - this.min) / (this.max - this.min) : 0;
    const a = Math.min(zero, frac);
    const b = Math.max(zero, frac);
    const arcLen = ((b - a) * SWEEP * C) / 360;
    this.arc.style.strokeDasharray = `${arcLen} ${C}`;
    this.arc.style.strokeDashoffset = `${-(a * SWEEP * C) / 360}`;
    this.pointer.style.transform = `rotate(${-SWEEP / 2 + frac * SWEEP}deg)`;
    this.readout.textContent = this.format(this.value);
    this.dial.setAttribute('aria-valuenow', String(Math.round(this.value * 100) / 100));
    if (notify) this.onChange(this.value);
  }
}

export class Fader {
  constructor(opts) {
    this.min = opts.min ?? 0;
    this.max = opts.max ?? 1;
    this.default = opts.default ?? opts.value ?? this.min;
    this.value = opts.value ?? this.default;
    this.vertical = opts.vertical !== false;
    this.onChange = opts.onChange ?? (() => {});
    this.format = opts.format ?? null;
    this.ticks = opts.ticks ?? 0;
    this.markers = opts.markers ?? [];
    this.snapTolerance = opts.snap ?? 0;
    this.snapEnabled = opts.snapEnabled ?? true;
    this.snapDuration = opts.snapDuration ?? 1000;
    this.snapRaf = 0;

    const el = document.createElement('div');
    el.className = `fader ${this.vertical ? 'vertical' : 'horizontal'}${opts.className ? ' ' + opts.className : ''}`;
    el.innerHTML = `
      <div class="fader-track" tabindex="0" role="slider"
           aria-valuemin="${this.min}" aria-valuemax="${this.max}" aria-label="${opts.label ?? ''}">
        <div class="fader-ticks"></div>
        <div class="fader-marks"></div>
        <div class="fader-fill"></div>
        <div class="fader-cap"></div>
      </div>
      ${this.format ? '<span class="fader-readout"></span>' : ''}`;

    this.el = el;
    this.track = el.querySelector('.fader-track');
    this.fill = el.querySelector('.fader-fill');
    this.cap = el.querySelector('.fader-cap');
    this.readout = el.querySelector('.fader-readout');
    if (opts.color) el.style.setProperty('--fader-color', opts.color);

    if (this.ticks) {
      const box = el.querySelector('.fader-ticks');
      for (let i = 0; i <= this.ticks; i++) {
        const t = document.createElement('i');
        t.style[this.vertical ? 'top' : 'left'] = `${(i / this.ticks) * 100}%`;
        box.appendChild(t);
      }
    }

    if (this.markers.length) {
      const box = el.querySelector('.fader-marks');
      const axis = this.vertical ? 'top' : 'left';
      const extent = this.vertical ? 'height' : 'width';
      for (const value of this.markers) {
        const frac = (value - this.min) / (this.max - this.min);
        const at = `${(this.vertical ? 1 - frac : frac) * 100}%`;
        if (this.snapTolerance > 0) {
          const zone = document.createElement('span');
          zone.className = 'snap-zone';
          zone.style[axis] = at;
          zone.style[extent] = `${this.snapTolerance * 2 * 100}%`;
          box.appendChild(zone);
        }
        const mark = document.createElement('span');
        mark.className = 'snap-mark';
        mark.dataset.label = String(Math.round(frac * 100));
        mark.style[axis] = at;
        box.appendChild(mark);
      }
    }

    this.#bind();
    this.setSnapEnabled(this.snapEnabled);
    this.set(this.value, false);
  }

  /** When off the snap zones are hidden and release-snapping stops. */
  setSnapEnabled(on) {
    this.snapEnabled = !!on;
    this.el.classList.toggle('no-snap', !this.snapEnabled);
    if (!this.snapEnabled) this.cancelSnap();
  }

  cancelSnap() {
    if (!this.snapRaf) return;
    cancelAnimationFrame(this.snapRaf);
    this.snapRaf = 0;
    this.el.classList.remove('snapping');
  }

  /** Glides to the marker so the crossfade is heard as a slow settle, not a jump. */
  #glideTo(target) {
    this.cancelSnap();
    const from = this.value;
    const delta = target - from;
    if (Math.abs(delta) < 1e-6) return;
    const started = performance.now();
    this.el.classList.add('snapping');
    const step = (now) => {
      const t = Math.min(1, (now - started) / this.snapDuration);
      const eased = 1 - Math.pow(1 - t, 3);
      this.set(from + delta * eased);
      if (t < 1) {
        this.snapRaf = requestAnimationFrame(step);
      } else {
        this.snapRaf = 0;
        this.el.classList.remove('snapping');
        this.set(target);
      }
    };
    this.snapRaf = requestAnimationFrame(step);
  }

  /** Nearest marker within tolerance, or null. Applied on release only. */
  #nearestMarker() {
    if (!this.snapEnabled || !this.markers.length || !this.snapTolerance) return null;
    const tolerance = this.snapTolerance * (this.max - this.min);
    let best = null;
    let bestDistance = Infinity;
    for (const marker of this.markers) {
      const distance = Math.abs(this.value - marker);
      if (distance <= tolerance && distance < bestDistance) {
        best = marker;
        bestDistance = distance;
      }
    }
    return best;
  }

  #bind() {
    let activeId = null;
    const apply = (e) => {
      const r = this.track.getBoundingClientRect();
      const frac = this.vertical
        ? 1 - clamp((e.clientY - r.top) / r.height, 0, 1)
        : clamp((e.clientX - r.left) / r.width, 0, 1);
      this.set(this.min + frac * (this.max - this.min));
    };
    this.track.addEventListener('pointerdown', (e) => {
      if (activeId !== null) return;
      this.cancelSnap();
      activeId = e.pointerId;
      try {
        this.track.setPointerCapture(e.pointerId);
      } catch {}
      this.el.classList.add('active');
      apply(e);
      e.preventDefault();
    });
    this.track.addEventListener('pointermove', (e) => {
      if (e.pointerId === activeId) apply(e);
    });
    const end = (e) => {
      if (e.pointerId !== activeId) return;
      activeId = null;
      try {
        this.track.releasePointerCapture(e.pointerId);
      } catch {}
      this.el.classList.remove('active');
      const marker = this.#nearestMarker();
      if (marker !== null) this.#glideTo(marker);
      this.onRelease?.();
    };
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);
    this.track.addEventListener('dblclick', () => {
      this.cancelSnap();
      this.set(this.default);
    });
    this.track.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.cancelSnap();
        const span = this.max - this.min;
        this.set(this.value - Math.sign(e.deltaY) * span * (e.shiftKey ? 0.002 : 0.02));
      },
      { passive: false }
    );
    this.track.addEventListener('keydown', (e) => {
      const k = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!k) return;
      e.preventDefault();
      this.cancelSnap();
      this.set(this.value + k * (this.max - this.min) * 0.02);
    });
  }

  set(v, notify = true) {
    this.value = clamp(v, this.min, this.max);
    const frac = (this.value - this.min) / (this.max - this.min);
    const pct = `${frac * 100}%`;
    if (this.vertical) {
      this.cap.style.bottom = pct;
      this.fill.style.height = pct;
    } else {
      this.cap.style.left = pct;
      this.fill.style.width = pct;
    }
    if (this.readout) this.readout.textContent = this.format(this.value);
    this.track.setAttribute('aria-valuenow', String(Math.round(this.value * 1000) / 1000));
    if (notify) this.onChange(this.value);
  }
}

export function segButton(options, value, onChange) {
  const el = document.createElement('div');
  el.className = 'seg';
  const buttons = options.map((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o.label;
    b.dataset.value = o.value;
    b.addEventListener('click', () => {
      set(o.value);
      onChange(o.value);
    });
    el.appendChild(b);
    return b;
  });
  function set(v) {
    for (const b of buttons) b.classList.toggle('on', b.dataset.value === String(v));
  }
  set(value);
  return { el, set };
}
