import { createFxRack } from './effects.js';

const WORKLETS = ['turntable-processor.js', 'keylock-processor.js', 'bitcrusher-processor.js', 'meter-processor.js'];

/**
 * Owns the AudioContext and every shared bus:
 * channels -> master sum -> master gain -> limiter -> speakers
 * channels -> PFL cue bus -> headphone mixer -> secondary output device
 */
export class Engine {
  constructor() {
    this.ctx = null;
    this.units = [];
    this.outputMode = 'headphones';
    this.cueDeviceId = '';
    this.masterDeviceId = '';
  }

  async init() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const base = new URL('../worklets/', import.meta.url);
    await Promise.all(WORKLETS.map((f) => this.ctx.audioWorklet.addModule(new URL(f, base))));

    const ctx = this.ctx;

    this.silentSink = ctx.createGain();
    this.silentSink.gain.value = 0;
    this.silentSink.connect(ctx.destination);

    this.masterSum = ctx.createGain();
    this.fxBus = ctx.createGain();
    this.cueBus = ctx.createGain();

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.85;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    this.masterSum.connect(this.masterGain);
    this.masterGain.connect(this.limiter);

    this.units = createFxRack(ctx, this.fxBus, this.masterSum);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;
    this.limiter.connect(this.analyser);

    // Headphone mixer: blends PFL cue bus with the master signal.
    this.cueSourceGain = ctx.createGain();
    this.cueMasterGain = ctx.createGain();
    this.cueSourceGain.gain.value = 1;
    this.cueMasterGain.gain.value = 0;
    this.phonesSum = ctx.createGain();
    this.phonesGain = ctx.createGain();
    this.phonesGain.gain.value = 0.7;

    this.cueBus.connect(this.cueSourceGain).connect(this.phonesSum);
    this.limiter.connect(this.cueMasterGain).connect(this.phonesSum);
    this.phonesSum.connect(this.phonesGain);

    this.cueStreamDest = ctx.createMediaStreamDestination();
    this.cueAudio = new Audio();
    this.cueAudio.srcObject = this.cueStreamDest.stream;
    this.cueAudio.autoplay = true;

    this.merger = ctx.createChannelMerger(4);
    this.masterSplitter = ctx.createChannelSplitter(2);
    this.phonesSplitter = ctx.createChannelSplitter(2);

    this.setOutputMode('headphones');
    this.beatTime = 60 / 128;
    return ctx;
  }

  createMeter(source, onLevel) {
    const node = new AudioWorkletNode(this.ctx, 'meter-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    node.port.onmessage = (e) => onLevel(e.data);
    source.connect(node);
    node.connect(this.silentSink);
    return node;
  }

  /**
   * 'headphones' - master on the default device, cue on a second output via setSinkId
   * 'split4'     - master on channels 1/2 and cue on channels 3/4 of one interface
   * 'master'     - no separate cue output
   */
  setOutputMode(mode) {
    const ctx = this.ctx;
    try {
      this.limiter.disconnect(ctx.destination);
    } catch {}
    try {
      this.limiter.disconnect(this.masterSplitter);
    } catch {}
    try {
      this.phonesGain.disconnect();
    } catch {}
    try {
      this.merger.disconnect();
    } catch {}
    try {
      ctx.destination.channelCountMode = 'max';
      ctx.destination.channelInterpretation = 'speakers';
      ctx.destination.channelCount = Math.min(2, ctx.destination.maxChannelCount);
    } catch {}

    this.outputMode = mode;

    if (mode === 'split4' && ctx.destination.maxChannelCount >= 4) {
      ctx.destination.channelCount = 4;
      ctx.destination.channelCountMode = 'explicit';
      ctx.destination.channelInterpretation = 'discrete';
      this.limiter.connect(this.masterSplitter);
      this.phonesGain.connect(this.phonesSplitter);
      this.masterSplitter.connect(this.merger, 0, 0);
      this.masterSplitter.connect(this.merger, 1, 1);
      this.phonesSplitter.connect(this.merger, 0, 2);
      this.phonesSplitter.connect(this.merger, 1, 3);
      this.merger.connect(ctx.destination);
      return { ok: true, mode };
    }

    this.limiter.connect(ctx.destination);
    if (mode === 'headphones') {
      this.phonesGain.connect(this.cueStreamDest);
      this.cueAudio.play().catch(() => {});
    }
    return { ok: true, mode: mode === 'split4' ? 'headphones' : mode };
  }

  async setCueDevice(deviceId) {
    this.cueDeviceId = deviceId;
    if (typeof this.cueAudio.setSinkId !== 'function') {
      throw new Error('setSinkId is not supported in this browser');
    }
    await this.cueAudio.setSinkId(deviceId);
    await this.cueAudio.play().catch(() => {});
  }

  /** Moves the master bus to another sound card. '' means the system default device. */
  async setMasterDevice(deviceId) {
    if (typeof this.ctx.setSinkId !== 'function') {
      throw new Error('AudioContext.setSinkId is not supported in this browser');
    }
    this.masterDeviceId = deviceId;
    await this.ctx.setSinkId(deviceId || '');
    // A new sink brings its own maxChannelCount, so the routing has to be rebuilt.
    const res = this.setOutputMode(this.outputMode);
    await this.resume();
    return res;
  }

  /** cueMix 0 = only cued channels, 1 = only master. */
  setCueMix(mix) {
    const t = this.ctx.currentTime;
    this.cueSourceGain.gain.setTargetAtTime(Math.cos((mix * Math.PI) / 2), t, 0.02);
    this.cueMasterGain.gain.setTargetAtTime(Math.sin((mix * Math.PI) / 2), t, 0.02);
  }

  setPhonesLevel(v) {
    this.phonesGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  setMasterLevel(v) {
    this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  setBeatTime(seconds) {
    if (!seconds || !isFinite(seconds)) return;
    this.beatTime = seconds;
    for (const u of this.units) u.setBeatTime(seconds);
  }

  resume() {
    if (this.ctx.state !== 'running') return this.ctx.resume();
    return Promise.resolve();
  }
}
