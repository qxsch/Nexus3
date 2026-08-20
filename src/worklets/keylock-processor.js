/**
 * Keylock (master tempo): constant-power two-tap granular pitch shifter.
 * Placed after the varispeed turntable and driven with shift = 1 / tempo so the
 * track changes speed without changing musical key.
 */

const GRAIN_SECONDS = 0.075;
const XFADE_SAMPLES = 1024;

class KeylockProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'shift', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.size = 1 << 15;
    this.mask = this.size - 1;
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
    this.write = 0;
    this.delay = 0;
    this.grain = Math.max(256, Math.round(GRAIN_SECONDS * sampleRate));
    this.blend = 0; // 0 = dry bypass, 1 = fully shifted
    this.enabled = true;
    this.port.onmessage = (e) => {
      if (e.data?.type === 'enable') this.enabled = !!e.data.value;
    };
  }

  tap(ch, delay) {
    const pos = this.write - delay + this.size;
    const i = Math.floor(pos);
    const t = pos - i;
    const a = ch[i & this.mask];
    const b = ch[(i + 1) & this.mask];
    return a + (b - a) * t;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const out = outputs[0];
    const n = out[0].length;

    if (!input || input.length === 0) {
      for (const c of out) c.fill(0);
      return true;
    }

    const shift = params.shift[0];
    const active = this.enabled && Math.abs(shift - 1) > 2e-4;
    const blendStep = 1 / XFADE_SAMPLES;
    const inc = 1 - shift;
    const grain = this.grain;

    const inL = input[0];
    const inR = input[1] ?? input[0];
    const outL = out[0];
    const outR = out[1] ?? out[0];
    const bufL = this.buf[0];
    const bufR = this.buf[1];

    for (let i = 0; i < n; i++) {
      const l = inL[i];
      const r = inR[i];
      bufL[this.write & this.mask] = l;
      bufR[this.write & this.mask] = r;
      this.write++;

      this.blend += (active ? blendStep : -blendStep);
      if (this.blend > 1) this.blend = 1;
      else if (this.blend < 0) this.blend = 0;

      if (this.blend <= 0) {
        outL[i] = l;
        if (outR !== outL) outR[i] = r;
        this.delay = 0;
        continue;
      }

      this.delay += inc;
      if (this.delay >= grain) this.delay -= grain;
      else if (this.delay < 0) this.delay += grain;

      const d1 = this.delay;
      const d2 = d1 < grain * 0.5 ? d1 + grain * 0.5 : d1 - grain * 0.5;
      const f1 = d1 / grain;
      const w1 = Math.sin(Math.PI * f1);
      const w2 = Math.sin(Math.PI * (d2 / grain));

      const sl = this.tap(bufL, d1) * w1 + this.tap(bufL, d2) * w2;
      const sr2 = this.tap(bufR, d1) * w1 + this.tap(bufR, d2) * w2;

      const b = this.blend;
      outL[i] = sl * b + l * (1 - b);
      if (outR !== outL) outR[i] = sr2 * b + r * (1 - b);
    }
    return true;
  }
}

registerProcessor('keylock-processor', KeylockProcessor);
