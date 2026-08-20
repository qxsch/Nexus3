/**
 * Offline track analysis on a worker thread:
 *  - multi-band waveform peaks (for the Rekordbox-style coloured waveform)
 *  - tempo estimation via onset-envelope comb filtering
 *  - beat grid phase (offset of the first beat)
 *
 * Message in : { id, mono: Float32Array, sampleRate }
 * Message out: { id, bpm, beatOffset, duration, bucketSize, min, max, low, mid, high }
 */

const BUCKET = 256;
const HOP = 256;
const MIN_BPM = 68;
const MAX_BPM = 200;
const ANALYSIS_LIMIT_SECONDS = 300;

function onePole(freq, sampleRate) {
  return Math.exp((-2 * Math.PI * freq) / sampleRate);
}

function analyse(mono, sampleRate) {
  const n = mono.length;
  const buckets = Math.ceil(n / BUCKET);
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const low = new Uint8Array(buckets);
  const mid = new Uint8Array(buckets);
  const high = new Uint8Array(buckets);

  const aLow = onePole(200, sampleRate);
  const aMid = onePole(2600, sampleRate);
  let zLow = 0;
  let zMid = 0;

  const frames = Math.ceil(n / HOP);
  const envLow = new Float32Array(frames);
  const envFull = new Float32Array(frames);

  let bMin = 1;
  let bMax = -1;
  let bLow = 0;
  let bMid = 0;
  let bHigh = 0;
  let bCount = 0;
  let bi = 0;

  let fLow = 0;
  let fFull = 0;
  let fCount = 0;
  let fi = 0;

  let peakLow = 1e-9;
  let peakMid = 1e-9;
  let peakHigh = 1e-9;
  const bandLow = new Float32Array(buckets);
  const bandMid = new Float32Array(buckets);
  const bandHigh = new Float32Array(buckets);

  for (let i = 0; i < n; i++) {
    const x = mono[i];
    zLow = x * (1 - aLow) + zLow * aLow;
    zMid = x * (1 - aMid) + zMid * aMid;
    const l = zLow;
    const m = zMid - zLow;
    const h = x - zMid;

    if (x < bMin) bMin = x;
    if (x > bMax) bMax = x;
    bLow += l * l;
    bMid += m * m;
    bHigh += h * h;
    bCount++;

    fLow += l * l;
    fFull += m * m + h * h;
    fCount++;

    if (bCount === BUCKET || i === n - 1) {
      min[bi] = bMin;
      max[bi] = bMax;
      const rl = Math.sqrt(bLow / bCount);
      const rm = Math.sqrt(bMid / bCount);
      const rh = Math.sqrt(bHigh / bCount);
      bandLow[bi] = rl;
      bandMid[bi] = rm;
      bandHigh[bi] = rh;
      if (rl > peakLow) peakLow = rl;
      if (rm > peakMid) peakMid = rm;
      if (rh > peakHigh) peakHigh = rh;
      bi++;
      bMin = 1;
      bMax = -1;
      bLow = bMid = bHigh = 0;
      bCount = 0;
    }

    if (fCount === HOP || i === n - 1) {
      envLow[fi] = Math.sqrt(fLow / fCount);
      envFull[fi] = Math.sqrt(fFull / fCount);
      fi++;
      fLow = fFull = 0;
      fCount = 0;
    }
  }

  for (let i = 0; i < buckets; i++) {
    low[i] = Math.min(255, Math.round((bandLow[i] / peakLow) * 255));
    mid[i] = Math.min(255, Math.round((bandMid[i] / peakMid) * 255));
    high[i] = Math.min(255, Math.round((bandHigh[i] / peakHigh) * 255));
  }

  const fps = sampleRate / HOP;
  const { bpm, beatOffset } = estimateTempo(envLow, envFull, fps);

  return {
    bpm,
    beatOffset,
    duration: n / sampleRate,
    bucketSize: BUCKET,
    min,
    max,
    low,
    mid,
    high
  };
}

function estimateTempo(envLow, envFull, fps) {
  const frames = Math.min(envLow.length, Math.floor(ANALYSIS_LIMIT_SECONDS * fps));
  if (frames < fps * 4) return { bpm: 0, beatOffset: 0 };

  // Half-wave rectified spectral-ish flux, weighted towards the low band (kick).
  const flux = new Float32Array(frames);
  for (let i = 1; i < frames; i++) {
    const dl = envLow[i] - envLow[i - 1];
    const df = envFull[i] - envFull[i - 1];
    flux[i] = (dl > 0 ? dl : 0) * 1.6 + (df > 0 ? df : 0) * 0.7;
  }

  // Remove local mean so loud sections do not dominate.
  const win = Math.round(fps * 0.75);
  const env = new Float32Array(frames);
  let running = 0;
  for (let i = 0; i < frames; i++) {
    running += flux[i];
    if (i >= win) running -= flux[i - win];
    const mean = running / Math.min(i + 1, win);
    const v = flux[i] - mean;
    env[i] = v > 0 ? v : 0;
  }

  let norm = 0;
  for (let i = 0; i < frames; i++) norm += env[i] * env[i];
  norm = Math.sqrt(norm / frames) || 1;
  for (let i = 0; i < frames; i++) env[i] /= norm;

  const minLag = Math.floor((60 / MAX_BPM) * fps);
  const maxLag = Math.ceil((60 / MIN_BPM) * fps);
  // Autocorrelation is computed up to 3x the slowest candidate so that every
  // candidate gets the same number of comb-filter harmonics.
  const scoreLag = Math.min(frames - 2, maxLag * 3);
  const scores = new Float32Array(scoreLag + 1);

  for (let lag = minLag; lag <= scoreLag; lag++) {
    let acc = 0;
    const limit = frames - lag;
    for (let i = 0; i < limit; i++) acc += env[i] * env[i + lag];
    scores[lag] = acc / limit;
  }

  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    // Comb filter: reward agreement at 2x and 3x the candidate period.
    let s = scores[lag];
    const l2 = lag * 2;
    const l3 = lag * 3;
    if (l2 <= scoreLag) s += scores[l2] * 0.5;
    if (l3 <= scoreLag) s += scores[l3] * 0.25;
    const bpm = (60 * fps) / lag;
    // Log-normal prior centred on 126 BPM keeps octave errors in check.
    const prior = Math.exp(-0.5 * Math.pow(Math.log(bpm / 126) / 0.32, 2));
    s *= 0.35 + 0.65 * prior;
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }

  // Sub-frame refinement by parabolic interpolation on the raw autocorrelation.
  let lag = best;
  if (best > minLag && best < maxLag) {
    const a = scores[best - 1];
    const b = scores[best];
    const c = scores[best + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) lag = best + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
  }

  // Octave check: score half, single and double time by how much onset energy each
  // beat grid collects on average, then let the tempo prior break the tie.
  const phaseScore = (period) => {
    let bestSum = -Infinity;
    let bestOffset = 0;
    const steps = Math.max(1, Math.round(period));
    for (let o = 0; o < steps; o++) {
      let sum = 0;
      let hits = 0;
      for (let t = o; t < frames; t += period) {
        const i = Math.round(t);
        if (i > 0 && i < frames - 1) {
          sum += env[i] + 0.5 * (env[i - 1] + env[i + 1]);
          hits++;
        }
      }
      const avg = hits ? sum / hits : 0;
      if (avg > bestSum) {
        bestSum = avg;
        bestOffset = o;
      }
    }
    return { score: bestSum, offset: bestOffset };
  };

  let winner = null;
  for (const factor of [0.5, 1, 2]) {
    const period = lag * factor;
    const bpmCandidate = (60 * fps) / period;
    if (bpmCandidate < MIN_BPM || bpmCandidate > MAX_BPM) continue;
    const { score, offset } = phaseScore(period);
    const prior = Math.exp(-0.5 * Math.pow(Math.log(bpmCandidate / 126) / 0.36, 2));
    const weighted = score * (0.3 + 0.7 * prior);
    if (!winner || weighted > winner.weighted) winner = { weighted, period, bpm: bpmCandidate, offset };
  }

  if (!winner) {
    let bpmFallback = (60 * fps) / lag;
    while (bpmFallback < MIN_BPM) bpmFallback *= 2;
    while (bpmFallback > MAX_BPM) bpmFallback /= 2;
    winner = { period: (60 * fps) / bpmFallback, bpm: bpmFallback, offset: 0 };
    winner.offset = phaseScore(winner.period).offset;
  }

  return { bpm: Math.round(winner.bpm * 100) / 100, beatOffset: winner.offset / fps };
}

self.onmessage = (event) => {
  const { id, mono, sampleRate } = event.data;
  const result = analyse(mono, sampleRate);
  self.postMessage({ id, ...result }, [
    result.min.buffer,
    result.max.buffer,
    result.low.buffer,
    result.mid.buffer,
    result.high.buffer
  ]);
};
