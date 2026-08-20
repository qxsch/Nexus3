/**
 * Virtual turntable: sample-accurate variable-rate player with motor inertia,
 * reverse playback, scratching and looping. Runs on the audio render thread.
 */

const POS_REPORT_FRAMES = 1024;

function hermite(ym1, y0, y1, y2, t) {
  const c1 = 0.5 * (y1 - ym1);
  const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2;
  const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
  return ((c3 * t + c2) * t + c1) * t + y0;
}

class TurntableProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = null;
    this.length = 0;

    this.position = 0;
    this.playing = false;
    this.ended = false;

    this.tempo = 1;
    this.nudge = 1;
    this.reverse = false;

    this.scratching = false;
    this.scratchRate = 0;
    this.platterHeld = false;

    this.rate = 0;
    this.spinUp = 0.28;
    this.spinDown = 0.55;

    this.loopActive = false;
    this.loopStart = 0;
    this.loopEnd = 0;

    this.reportCounter = 0;
    this.port.onmessage = (e) => this.handle(e.data);
  }

  handle(msg) {
    switch (msg.type) {
      case 'load':
        this.channels = msg.channels;
        this.length = msg.length;
        this.position = 0;
        this.rate = 0;
        this.playing = false;
        this.ended = false;
        this.loopActive = false;
        this.port.postMessage({ type: 'loaded' });
        break;
      case 'unload':
        this.channels = null;
        this.length = 0;
        this.position = 0;
        this.rate = 0;
        this.playing = false;
        break;
      case 'play':
        if (!this.channels) break;
        if (this.position >= this.length - 1) this.position = 0;
        this.playing = true;
        this.ended = false;
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'stop':
        this.playing = false;
        this.rate = 0;
        this.position = msg.position ?? 0;
        break;
      case 'seek':
        this.position = Math.max(0, Math.min(this.length - 1, msg.position));
        this.ended = false;
        break;
      case 'tempo':
        this.tempo = msg.value;
        break;
      case 'nudge':
        this.nudge = msg.value;
        break;
      case 'reverse':
        this.reverse = !!msg.value;
        break;
      case 'jog':
        this.scratching = !!msg.active;
        if (msg.rate !== undefined) this.scratchRate = msg.rate;
        break;
      case 'platter':
        this.platterHeld = !!msg.held;
        break;
      case 'loop':
        this.loopActive = !!msg.active;
        if (msg.start !== undefined) this.loopStart = msg.start;
        if (msg.end !== undefined) this.loopEnd = msg.end;
        break;
      case 'motor':
        if (msg.spinUp !== undefined) this.spinUp = msg.spinUp;
        if (msg.spinDown !== undefined) this.spinDown = msg.spinDown;
        break;
    }
  }

  read(ch, index) {
    if (index < 0 || index >= this.length) return 0;
    return ch[index];
  }

  sample(ch, pos) {
    const i = Math.floor(pos);
    const t = pos - i;
    return hermite(this.read(ch, i - 1), this.read(ch, i), this.read(ch, i + 1), this.read(ch, i + 2), t);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] ?? out[0];
    const n = left.length;

    if (!this.channels) {
      left.fill(0);
      if (right !== left) right.fill(0);
      return true;
    }

    const chL = this.channels[0];
    const chR = this.channels[1] ?? this.channels[0];
    const sr = sampleRate;

    for (let i = 0; i < n; i++) {
      let target;
      let tc;
      if (this.scratching) {
        target = this.scratchRate;
        tc = 0.006;
      } else if (this.platterHeld) {
        target = 0;
        tc = 0.02;
      } else if (this.playing && !this.ended) {
        target = this.tempo * this.nudge * (this.reverse ? -1 : 1);
        tc = Math.abs(this.rate) < 0.02 ? this.spinUp : 0.03;
      } else {
        target = 0;
        tc = this.spinDown;
      }

      const coeff = 1 - Math.exp(-1 / (Math.max(tc, 0.0005) * sr));
      this.rate += (target - this.rate) * coeff;
      if (Math.abs(target - this.rate) < 1e-6) this.rate = target;

      const p = this.position;
      if (p < 0 || p >= this.length) {
        left[i] = 0;
        if (right !== left) right[i] = 0;
      } else {
        left[i] = this.sample(chL, p);
        if (right !== left) right[i] = this.sample(chR, p);
      }

      this.position += this.rate;

      if (this.loopActive && this.loopEnd > this.loopStart) {
        const span = this.loopEnd - this.loopStart;
        if (this.position >= this.loopEnd) this.position -= span;
        else if (this.position < this.loopStart) this.position += span;
      }

      if (this.position < 0) {
        this.position = 0;
        this.rate = 0;
      } else if (this.position >= this.length) {
        this.position = this.length - 1;
        this.rate = 0;
        if (this.playing) {
          this.playing = false;
          this.ended = true;
          this.port.postMessage({ type: 'ended' });
        }
      }
    }

    this.reportCounter += n;
    if (this.reportCounter >= POS_REPORT_FRAMES) {
      this.reportCounter = 0;
      this.port.postMessage({
        type: 'position',
        position: this.position,
        rate: this.rate,
        playing: this.playing
      });
    }
    return true;
  }
}

registerProcessor('turntable-processor', TurntableProcessor);
