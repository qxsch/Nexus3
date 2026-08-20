/**
 * Cross-window hot state, carried in one SharedArrayBuffer.
 *
 * The console window writes every animation frame; panel windows read on their own
 * frame and extrapolate the playhead from (position, rate, hostTime), so a detached
 * waveform scrolls as smoothly as a local one even though the numbers arrive late.
 * Only the Electron shell sets the COOP/COEP headers that make this available.
 */

export const DECK_COUNT = 3;
export const DECK_SLOTS = 32;
export const SPECTRUM_BINS = 1024;

const NUMBERS_OFFSET = 64;
const NUMBER_COUNT = DECK_COUNT * DECK_SLOTS + 32;
const SPECTRUM_OFFSET = NUMBERS_OFFSET + NUMBER_COUNT * 8;
export const SAB_BYTES = SPECTRUM_OFFSET + SPECTRUM_BINS;

export const D = {
  position: 0,
  rate: 1,
  duration: 2,
  tempo: 3,
  bpm: 4,
  beatOffset: 5,
  cuePoint: 6,
  loopStart: 7,
  loopEnd: 8,
  loopBeats: 9,
  flags: 10,
  peakL: 11,
  peakR: 12,
  rms: 13,
  sampleRate: 14,
  hostTime: 15,
  analysisRev: 16,
  hotCue0: 17 // 17..24
};

const MASTER = DECK_COUNT * DECK_SLOTS;
export const M = {
  peakL: MASTER + 0,
  peakR: MASTER + 1,
  rms: MASTER + 2,
  ctxTime: MASTER + 3,
  beatTime: MASTER + 4,
  hostTime: MASTER + 5,
  ready: MASTER + 6,
  spectrumRate: MASTER + 7
};

export const F = {
  playing: 1 << 0,
  sync: 1 << 1,
  keylock: 1 << 2,
  reverse: 1 << 3,
  cueOn: 1 << 4,
  loopActive: 1 << 5,
  stream: 1 << 6,
  loaded: 1 << 7,
  syncMaster: 1 << 8
};

export function createSharedState(buffer = new SharedArrayBuffer(SAB_BYTES)) {
  return {
    buffer,
    gen: new Int32Array(buffer, 0, 1),
    num: new Float64Array(buffer, NUMBERS_OFFSET, NUMBER_COUNT),
    spectrum: new Uint8Array(buffer, SPECTRUM_OFFSET, SPECTRUM_BINS)
  };
}

export const deckSlot = (index, slot) => index * DECK_SLOTS + slot;

/** Playhead between two publishes, so panel windows never show a stepping waveform. */
export function extrapolate(state, index, nowMs) {
  const base = index * DECK_SLOTS;
  const pos = state.num[base + D.position];
  const rate = state.num[base + D.rate];
  const dur = state.num[base + D.duration];
  const dt = Math.max(0, Math.min(0.25, (nowMs - state.num[base + D.hostTime]) / 1000));
  const p = pos + rate * dt;
  return dur > 0 ? Math.max(0, Math.min(dur, p)) : Math.max(0, p);
}
