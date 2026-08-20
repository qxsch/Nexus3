/** Bit crusher / sample-rate reducer with soft-saturated output. */
class BitcrusherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'reduction', defaultValue: 4, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
      { name: 'drive', defaultValue: 1, minValue: 0.5, maxValue: 6, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.phase = 0;
    this.hold = [0, 0];
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const out = outputs[0];
    if (!input || input.length === 0) {
      for (const c of out) c.fill(0);
      return true;
    }
    const bits = params.bits[0];
    const step = Math.pow(0.5, bits - 1);
    const red = params.reduction[0];
    const drive = params.drive[0];
    const inL = input[0];
    const inR = input[1] ?? input[0];
    const outL = out[0];
    const outR = out[1] ?? out[0];

    for (let i = 0; i < outL.length; i++) {
      this.phase += 1;
      if (this.phase >= red) {
        this.phase -= red;
        this.hold[0] = step * Math.floor(inL[i] / step + 0.5);
        this.hold[1] = step * Math.floor(inR[i] / step + 0.5);
      }
      outL[i] = Math.tanh(this.hold[0] * drive);
      if (outR !== outL) outR[i] = Math.tanh(this.hold[1] * drive);
    }
    return true;
  }
}

registerProcessor('bitcrusher-processor', BitcrusherProcessor);
