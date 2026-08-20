/** Peak / RMS metering on the audio thread; posts levels ~40x per second. */
class MeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.peakL = 0;
    this.peakR = 0;
    this.sum = 0;
    this.count = 0;
    this.frames = 0;
    this.interval = Math.round(sampleRate / 40);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    if (input && input.length) {
      const L = input[0];
      const R = input[1] ?? input[0];
      for (let i = 0; i < L.length; i++) {
        const l = L[i] < 0 ? -L[i] : L[i];
        const r = R[i] < 0 ? -R[i] : R[i];
        if (l > this.peakL) this.peakL = l;
        if (r > this.peakR) this.peakR = r;
        this.sum += (L[i] * L[i] + R[i] * R[i]) * 0.5;
        this.count++;
      }
      this.frames += L.length;
    } else {
      this.frames += 128;
    }

    for (const c of outputs[0]) c.fill(0);

    if (this.frames >= this.interval) {
      this.port.postMessage({
        peakL: this.peakL,
        peakR: this.peakR,
        rms: this.count ? Math.sqrt(this.sum / this.count) : 0
      });
      this.frames = 0;
      this.peakL = 0;
      this.peakR = 0;
      this.sum = 0;
      this.count = 0;
    }
    return true;
  }
}

registerProcessor('meter-processor', MeterProcessor);
