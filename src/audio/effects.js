/** Master FX rack units. Every unit is a send effect: input -> processing -> amount -> output. */

function makeIR(ctx, seconds, decay, brightness) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = ir.getChannelData(c);
    let lp = 0;
    const a = Math.exp(-2 * Math.PI * brightness / ctx.sampleRate);
    for (let i = 0; i < len; i++) {
      const noise = Math.random() * 2 - 1;
      lp = noise * (1 - a) + lp * a;
      const env = Math.pow(1 - i / len, decay);
      // Sparse early reflections give the tail some shape.
      const spark = i < len * 0.02 && Math.random() < 0.02 ? 2.5 : 1;
      data[i] = lp * env * spark;
    }
  }
  return ir;
}

class FxUnit {
  constructor(ctx, id, label) {
    this.ctx = ctx;
    this.id = id;
    this.label = label;
    this.input = ctx.createGain();
    this.input.gain.value = 0;
    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.enabled = false;
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.input.gain.setTargetAtTime(this.enabled ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  setAmount(v) {
    this.output.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  setBeatTime() {}
}

export class DelayUnit extends FxUnit {
  constructor(ctx) {
    super(ctx, 'delay', 'Echo');
    this.delay = ctx.createDelay(4);
    this.delay.delayTime.value = 0.375;
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.45;
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 4200;
    this.beats = 1;
    this.beatTime = 60 / 128;

    this.input.connect(this.delay);
    this.delay.connect(this.tone);
    this.tone.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.delay.connect(this.output);
  }

  setParam(name, v) {
    const t = this.ctx.currentTime;
    if (name === 'feedback') this.feedback.gain.setTargetAtTime(v, t, 0.03);
    if (name === 'tone') this.tone.frequency.setTargetAtTime(v, t, 0.03);
    if (name === 'beats') {
      this.beats = v;
      this.setBeatTime(this.beatTime);
    }
  }

  setBeatTime(seconds) {
    this.beatTime = seconds;
    const t = Math.max(0.01, Math.min(4, seconds * this.beats));
    this.delay.delayTime.setTargetAtTime(t, this.ctx.currentTime, 0.08);
  }
}

export class ReverbUnit extends FxUnit {
  constructor(ctx) {
    super(ctx, 'reverb', 'Reverb');
    this.pre = ctx.createBiquadFilter();
    this.pre.type = 'highpass';
    this.pre.frequency.value = 260;
    this.conv = ctx.createConvolver();
    this.conv.buffer = makeIR(ctx, 2.6, 2.6, 5200);
    this.damp = ctx.createBiquadFilter();
    this.damp.type = 'lowpass';
    this.damp.frequency.value = 7000;

    this.input.connect(this.pre);
    this.pre.connect(this.conv);
    this.conv.connect(this.damp);
    this.damp.connect(this.output);
  }

  setParam(name, v) {
    const t = this.ctx.currentTime;
    if (name === 'damp') this.damp.frequency.setTargetAtTime(v, t, 0.05);
    if (name === 'size') {
      this.conv.buffer = makeIR(this.ctx, 0.4 + v * 5, 2.2 + v * 1.6, 5200);
    }
  }
}

export class FlangerUnit extends FxUnit {
  constructor(ctx) {
    super(ctx, 'flanger', 'Flanger');
    this.delay = ctx.createDelay(0.05);
    this.delay.delayTime.value = 0.004;
    this.depth = ctx.createGain();
    this.depth.gain.value = 0.0025;
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0.35;
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.6;

    this.lfo.connect(this.depth);
    this.depth.connect(this.delay.delayTime);
    this.lfo.start();

    this.input.connect(this.delay);
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.delay.connect(this.output);
  }

  setParam(name, v) {
    const t = this.ctx.currentTime;
    if (name === 'rate') this.lfo.frequency.setTargetAtTime(v, t, 0.05);
    if (name === 'depth') this.depth.gain.setTargetAtTime(v, t, 0.05);
    if (name === 'feedback') this.feedback.gain.setTargetAtTime(v, t, 0.05);
  }
}

export class CrusherUnit extends FxUnit {
  constructor(ctx) {
    super(ctx, 'crusher', 'Crush');
    this.node = new AudioWorkletNode(ctx, 'bitcrusher-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    this.post = ctx.createBiquadFilter();
    this.post.type = 'lowpass';
    this.post.frequency.value = 11000;
    this.input.connect(this.node);
    this.node.connect(this.post);
    this.post.connect(this.output);
  }

  setParam(name, v) {
    const t = this.ctx.currentTime;
    if (name === 'bits') this.node.parameters.get('bits').setTargetAtTime(v, t, 0.02);
    if (name === 'reduction') this.node.parameters.get('reduction').setTargetAtTime(v, t, 0.02);
    if (name === 'drive') this.node.parameters.get('drive').setTargetAtTime(v, t, 0.02);
  }
}

export function createFxRack(ctx, sendBus, destination) {
  const units = [new DelayUnit(ctx), new ReverbUnit(ctx), new FlangerUnit(ctx), new CrusherUnit(ctx)];
  for (const u of units) {
    sendBus.connect(u.input);
    u.output.connect(destination);
  }
  return units;
}
