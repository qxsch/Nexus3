/** Synthesises loopable demo tracks so the mixer is playable without any files. */

const SCALES = {
  house: { root: 55, notes: [0, 0, 7, 0, 10, 0, 5, 7], chord: [0, 3, 7, 10] },
  techno: { root: 49, notes: [0, 0, 0, 12, 0, 0, 7, 0], chord: [0, 5, 7, 12] },
  hiphop: { root: 46, notes: [0, 0, 3, 5, 0, 0, 10, 7], chord: [0, 3, 7, 14] }
};

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function noiseBuffer(ctx, seconds = 2) {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function kick(ctx, out, t, gain = 1) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(140, t);
  osc.frequency.exponentialRampToValueAtTime(44, t + 0.09);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0008, t + 0.42);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.5);

  const click = ctx.createOscillator();
  const cg = ctx.createGain();
  click.type = 'triangle';
  click.frequency.setValueAtTime(900, t);
  cg.gain.setValueAtTime(gain * 0.35, t);
  cg.gain.exponentialRampToValueAtTime(0.0005, t + 0.02);
  click.connect(cg).connect(out);
  click.start(t);
  click.stop(t + 0.03);
}

function noiseHit(ctx, out, noise, t, { freq, q, decay, gain, type }) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0005, t + decay);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random());
  src.stop(t + decay + 0.05);
}

function bassNote(ctx, out, t, dur, freq, gain = 0.5) {
  const osc = ctx.createOscillator();
  const sub = ctx.createOscillator();
  const f = ctx.createBiquadFilter();
  const g = ctx.createGain();
  osc.type = 'sawtooth';
  sub.type = 'sine';
  osc.frequency.value = freq;
  sub.frequency.value = freq / 2;
  f.type = 'lowpass';
  f.Q.value = 6;
  f.frequency.setValueAtTime(freq * 8, t);
  f.frequency.exponentialRampToValueAtTime(freq * 1.6, t + dur * 0.8);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.setValueAtTime(gain, t + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
  osc.connect(f);
  sub.connect(f);
  f.connect(g).connect(out);
  osc.start(t);
  sub.start(t);
  osc.stop(t + dur + 0.02);
  sub.stop(t + dur + 0.02);
}

function stab(ctx, out, t, dur, freqs, gain = 0.18) {
  const f = ctx.createBiquadFilter();
  const g = ctx.createGain();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(4200, t);
  f.frequency.exponentialRampToValueAtTime(900, t + dur);
  f.Q.value = 2;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
  f.connect(g).connect(out);
  for (const fr of freqs) {
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = fr * Math.pow(2, det / 1200);
      o.connect(f);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
  }
}

export async function renderDemoTrack({ sampleRate, bpm, style = 'house', bars = 16 }) {
  const spb = 60 / bpm;
  const total = bars * 4 * spb + 0.6;
  const ctx = new OfflineAudioContext(2, Math.ceil(total * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  const noise = noiseBuffer(ctx, 2);
  const cfg = SCALES[style] ?? SCALES.house;
  const swing = style === 'hiphop' ? 0.06 * spb : 0;

  for (let bar = 0; bar < bars; bar++) {
    const barT = bar * 4 * spb;
    const section = Math.floor(bar / 4) % 4;

    for (let beat = 0; beat < 4; beat++) {
      const t = barT + beat * spb;

      if (style === 'hiphop') {
        if (beat === 0 || beat === 2) kick(ctx, master, t, 1);
        if (beat === 2) kick(ctx, master, t + spb * 0.5, 0.7);
      } else {
        kick(ctx, master, t, 1);
      }

      if (beat === 1 || beat === 3) {
        noiseHit(ctx, master, noise, t, {
          freq: 1900,
          q: 1.1,
          decay: style === 'techno' ? 0.12 : 0.19,
          gain: 0.45,
          type: 'bandpass'
        });
      }

      for (let s = 0; s < 2; s++) {
        const ht = t + s * spb * 0.5 + (s === 1 ? swing : 0);
        noiseHit(ctx, master, noise, ht, {
          freq: 8200,
          q: 0.8,
          decay: s === 1 ? 0.06 : 0.035,
          gain: s === 1 ? 0.16 : 0.1,
          type: 'highpass'
        });
      }

      if (section > 0) {
        const step = (bar * 4 + beat) % cfg.notes.length;
        bassNote(ctx, master, t + spb * 0.5, spb * 0.45, midiToFreq(cfg.root + cfg.notes[step]), 0.42);
        if (beat % 2 === 0) {
          bassNote(ctx, master, t, spb * 0.4, midiToFreq(cfg.root + cfg.notes[step]), 0.5);
        }
      }

      if (section > 1 && beat % 2 === 1) {
        stab(
          ctx,
          master,
          t + spb * 0.5,
          spb * 0.9,
          cfg.chord.map((iv) => midiToFreq(cfg.root + 24 + iv)),
          0.15
        );
      }
    }
  }

  return ctx.startRendering();
}
