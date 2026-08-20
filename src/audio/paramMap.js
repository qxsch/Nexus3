/**
 * Maps mixer parameter ids onto the audio graph. Only the window that owns the
 * AudioContext runs this; panel windows just publish parameter changes.
 */

const CURVES = { slow: 2, smooth: 1, sharp: 0.28 };

export const FX_PARAMS = {
  delay: { amt: 0.6, feedback: 0.45, tone: 4200, beats: 1 },
  reverb: { amt: 0.6, size: 0.45, damp: 7000 },
  flanger: { amt: 0.6, rate: 0.35, depth: 0.0025, feedback: 0.6 },
  crusher: { amt: 0.6, bits: 8, reduction: 4, drive: 1.4 }
};

export function defaultParams(deckCount = 3) {
  const out = {
    'xf.value': 0.5,
    'xf.curve': 'smooth',
    'xf.snap': true,
    'master.gain': 0.85,
    'master.cueMix': 0,
    'master.phones': 0.7,
    'out.mode': 'headphones',
    'out.device': '',
    'out.master': ''
  };
  for (let i = 0; i < deckCount; i++) {
    out[`ch${i}.trim`] = 1;
    out[`ch${i}.eq.high`] = 0;
    out[`ch${i}.eq.mid`] = 0;
    out[`ch${i}.eq.low`] = 0;
    out[`ch${i}.filter`] = 0;
    out[`ch${i}.fx`] = 0;
    out[`ch${i}.assign`] = 'THRU';
    out[`ch${i}.fader`] = 0.8;
  }
  for (const [unit, params] of Object.entries(FX_PARAMS)) {
    out[`fx.${unit}.on`] = false;
    for (const [k, v] of Object.entries(params)) out[`fx.${unit}.${k}`] = v;
  }
  return out;
}

// Knob travel is symmetric around the 12 o'clock detent; the dB curve is not.
export const eqToDb = (v) => (v >= 0 ? v * 6 : v * 32);

function crossfadeGains(x, power) {
  return {
    A: Math.pow(Math.cos((x * Math.PI) / 2), power),
    B: Math.pow(Math.sin((x * Math.PI) / 2), power)
  };
}

export function applyCrossfade(engineApp) {
  const { decks, params } = engineApp;
  const g = crossfadeGains(params.get('xf.value', 0.5), CURVES[params.get('xf.curve', 'smooth')] ?? 1);
  for (const deck of decks) {
    const assign = params.get(`ch${deck.index}.assign`, 'THRU');
    deck.setCrossfadeGain(assign === 'A' ? g.A : assign === 'B' ? g.B : 1);
  }
}

/** Applies one parameter to the live audio graph. */
export function applyParam(engineApp, id, value) {
  const { engine, decks } = engineApp;

  const ch = /^ch(\d+)\.(.+)$/.exec(id);
  if (ch) {
    const deck = decks[Number(ch[1])];
    if (!deck) return;
    const what = ch[2];
    if (what === 'trim') return deck.setTrim(value);
    if (what === 'filter') return deck.setFilter(value);
    if (what === 'fx') return deck.setFxSend(value);
    if (what === 'fader') return deck.setFader(value);
    if (what === 'assign') return applyCrossfade(engineApp);
    const eq = /^eq\.(high|mid|low)$/.exec(what);
    if (eq) return deck.setEq(eq[1], eqToDb(value));
    return;
  }

  const fx = /^fx\.([a-z]+)\.(.+)$/.exec(id);
  if (fx) {
    const unit = engine.units.find((u) => u.id === fx[1]);
    if (!unit) return;
    if (fx[2] === 'on') return unit.setEnabled(!!value);
    if (fx[2] === 'amt') return unit.setAmount(value);
    return unit.setParam(fx[2], value);
  }

  if (id === 'xf.value' || id === 'xf.curve') return applyCrossfade(engineApp);
  if (id === 'master.gain') return engine.setMasterLevel(value);
  if (id === 'master.cueMix') return engine.setCueMix(value);
  if (id === 'master.phones') return engine.setPhonesLevel(value);
  if (id === 'out.mode') return engine.setOutputMode(value);
  if (id === 'out.device') return void engine.setCueDevice(value).catch(() => {});
  if (id === 'out.master') return void engine.setMasterDevice(value).catch(() => {});
}

export function applyAllParams(engineApp) {
  for (const id of Object.keys(engineApp.params.snapshot())) {
    if (id.startsWith('out.')) continue; // routing is applied when the user picks it
    applyParam(engineApp, id, engineApp.params.get(id));
  }
  applyCrossfade(engineApp);
}
