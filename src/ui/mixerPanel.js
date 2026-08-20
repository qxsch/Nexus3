import { Knob, Fader, segButton } from './controls.js';
import { Meter, Spectrum } from './visuals.js';
import { eqToDb } from '../audio/paramMap.js';

// Controls are views over the parameter store, so they survive a panel moving between
// windows and follow changes made in another window.
function knobParam(params, id, opts) {
  const knob = new Knob({ ...opts, value: params.get(id, opts.default), onChange: (v) => params.set(id, v) });
  params.subscribe(id, (v) => {
    if (v !== knob.value) knob.set(v, false);
  });
  return knob;
}

function faderParam(params, id, opts) {
  const fader = new Fader({ ...opts, value: params.get(id, opts.default), onChange: (v) => params.set(id, v) });
  params.subscribe(id, (v) => {
    if (v !== fader.value) fader.set(v, false);
  });
  return fader;
}

function segParam(params, id, options, def, cast = (v) => v) {
  const seg = segButton(options, String(params.get(id, def)), (v) => params.set(id, cast(v)));
  params.subscribe(id, (v) => seg.set(String(v)));
  return seg;
}

const FX_LAYOUT = {
  delay: {
    title: 'Echo',
    knobs: [
      { param: 'feedback', label: 'FDBK', min: 0, max: 0.92, def: 0.45, fmt: (v) => `${(v * 100) | 0}` },
      { param: 'tone', label: 'TONE', min: 400, max: 16000, def: 4200, fmt: (v) => `${(v / 1000).toFixed(1)}k` }
    ],
    seg: {
      param: 'beats',
      options: [
        { label: '1/4', value: '0.25' },
        { label: '1/2', value: '0.5' },
        { label: '1', value: '1' },
        { label: '2', value: '2' }
      ],
      def: 1
    }
  },
  reverb: {
    title: 'Reverb',
    knobs: [
      { param: 'size', label: 'SIZE', min: 0.05, max: 1, def: 0.45, fmt: (v) => v.toFixed(2) },
      { param: 'damp', label: 'DAMP', min: 900, max: 16000, def: 7000, fmt: (v) => `${(v / 1000).toFixed(1)}k` }
    ]
  },
  flanger: {
    title: 'Flanger',
    knobs: [
      { param: 'rate', label: 'RATE', min: 0.03, max: 6, def: 0.35, fmt: (v) => `${v.toFixed(2)}` },
      { param: 'depth', label: 'DEPTH', min: 0.0002, max: 0.008, def: 0.0025, fmt: (v) => (v * 1000).toFixed(1) },
      { param: 'feedback', label: 'FDBK', min: 0, max: 0.92, def: 0.6, fmt: (v) => `${(v * 100) | 0}` }
    ]
  },
  crusher: {
    title: 'Crush',
    knobs: [
      { param: 'bits', label: 'BITS', min: 1, max: 16, def: 8, fmt: (v) => v.toFixed(0) },
      { param: 'reduction', label: 'RATE', min: 1, max: 40, def: 4, fmt: (v) => v.toFixed(0) },
      { param: 'drive', label: 'DRIVE', min: 0.5, max: 5, def: 1.4, fmt: (v) => v.toFixed(1) }
    ]
  }
};

export function buildFxRack(app) {
  const { engine, params } = app;

  const el = document.createElement('aside');
  el.className = 'panel';
  el.innerHTML = `<div class="panel-title">FX rack · send</div><div class="fx-rack"></div>`;
  const rack = el.querySelector('.fx-rack');

  for (const unit of engine.units) {
    const cfg = FX_LAYOUT[unit.id];
    if (!cfg) continue;
    const box = document.createElement('div');
    box.className = 'fx-unit';
    box.style.setProperty('--deck-color', '#a78bfa');
    box.innerHTML = `<div class="fx-head"><b>${cfg.title}</b></div><div class="fx-knobs"></div>`;

    const onId = `fx.${unit.id}.on`;
    const onBtn = document.createElement('button');
    onBtn.type = 'button';
    onBtn.textContent = 'ON';
    onBtn.classList.toggle('on', !!params.get(onId, false));
    onBtn.addEventListener('click', () => params.set(onId, !params.get(onId, false)));
    params.subscribe(onId, (v) => onBtn.classList.toggle('on', !!v));
    box.querySelector('.fx-head').appendChild(onBtn);

    const knobs = box.querySelector('.fx-knobs');
    knobs.appendChild(
      knobParam(params, `fx.${unit.id}.amt`, {
        label: 'AMT',
        min: 0,
        max: 1.4,
        default: 0.6,
        size: 40,
        color: '#a78bfa',
        format: (v) => `${(v * 71) | 0}`
      }).el
    );

    for (const k of cfg.knobs) {
      knobs.appendChild(
        knobParam(params, `fx.${unit.id}.${k.param}`, {
          label: k.label,
          min: k.min,
          max: k.max,
          default: k.def,
          size: 40,
          color: '#a78bfa',
          format: k.fmt
        }).el
      );
    }

    if (cfg.seg) {
      const seg = segParam(params, `fx.${unit.id}.${cfg.seg.param}`, cfg.seg.options, cfg.seg.def, Number);
      seg.el.style.marginTop = '6px';
      seg.el.style.setProperty('--deck-color', '#a78bfa');
      box.appendChild(seg.el);
    }
    rack.appendChild(box);
  }

  return { el, update() {}, resize() {} };
}

export function buildChannels(app) {
  const { decks, params } = app;

  const el = document.createElement('section');
  el.className = 'panel';
  el.innerHTML = `<div class="panel-title">Channels</div><div class="strips"></div>
    <div class="crossfader-row">
      <span class="xf-label">A</span>
      <div class="js-xf" style="flex:1"></div>
      <span class="xf-label">B</span>
      <button class="ghost js-snap" type="button" title="Snap the crossfader to 25, 50 and 75 on release">SNAP</button>
      <div class="seg js-curve" style="width:150px"></div>
    </div>`;
  const strips = el.querySelector('.strips');

  const meters = [];
  for (const deck of decks) {
    const i = deck.index;
    const strip = document.createElement('div');
    strip.className = 'strip';
    strip.style.setProperty('--deck-color', deck.color);
    strip.innerHTML = `
      <div class="strip-head"><b>${deck.label}</b><span class="js-name">empty</span></div>
      <div class="js-trim"></div>
      <div class="eq-block js-eq"></div>
      <div class="js-color"></div>
      <div class="js-fx"></div>
      <div class="seg js-assign"></div>
      <button class="js-cue" type="button" style="width:100%">CUE</button>
      <div class="strip-bottom">
        <canvas class="meter"></canvas>
        <div class="js-vol"></div>
      </div>`;

    strip.querySelector('.js-trim').appendChild(
      knobParam(params, `ch${i}.trim`, {
        label: 'TRIM',
        min: 0,
        max: 2,
        default: 1,
        size: 40,
        bipolar: true,
        color: deck.color,
        format: (v) => `${(20 * Math.log10(Math.max(0.001, v))).toFixed(1)}`
      }).el
    );

    const eqBox = strip.querySelector('.js-eq');
    for (const band of ['high', 'mid', 'low']) {
      eqBox.appendChild(
        knobParam(params, `ch${i}.eq.${band}`, {
          label: band === 'high' ? 'HI' : band === 'mid' ? 'MID' : 'LOW',
          min: -1,
          max: 1,
          default: 0,
          size: 40,
          bipolar: true,
          color: deck.color,
          format: (v) => (v <= -0.985 ? 'KILL' : `${v > 0 ? '+' : ''}${eqToDb(v).toFixed(1)}`)
        }).el
      );
    }

    strip.querySelector('.js-color').appendChild(
      knobParam(params, `ch${i}.filter`, {
        label: 'FILTER',
        min: -1,
        max: 1,
        default: 0,
        size: 46,
        bipolar: true,
        color: deck.color,
        format: (v) =>
          Math.abs(v) < 0.02 ? 'OFF' : v < 0 ? `LP ${Math.round(-v * 100)}` : `HP ${Math.round(v * 100)}`
      }).el
    );

    strip.querySelector('.js-fx').appendChild(
      knobParam(params, `ch${i}.fx`, {
        label: 'FX',
        min: 0,
        max: 1,
        default: 0,
        size: 40,
        color: '#a78bfa',
        format: (v) => `${(v * 100) | 0}`
      }).el
    );

    const assign = segParam(
      params,
      `ch${i}.assign`,
      [
        { label: 'A', value: 'A' },
        { label: '–', value: 'THRU' },
        { label: 'B', value: 'B' }
      ],
      'THRU'
    );
    strip.querySelector('.js-assign').replaceWith(assign.el);
    assign.el.style.setProperty('--deck-color', deck.color);

    const cueBtn = strip.querySelector('.js-cue');
    cueBtn.addEventListener('click', () => deck.setCue(!deck.cueOn));

    strip.querySelector('.js-vol').appendChild(
      faderParam(params, `ch${i}.fader`, {
        min: 0,
        max: 1,
        default: 0.8,
        vertical: true,
        ticks: 8,
        color: deck.color,
        label: `Deck ${deck.label} volume`
      }).el
    );

    strips.appendChild(strip);
    meters.push({
      deck,
      meter: new Meter(strip.querySelector('canvas.meter')),
      cueBtn,
      name: strip.querySelector('.js-name')
    });
  }

  const xf = faderParam(params, 'xf.value', {
    min: 0,
    max: 1,
    default: 0.5,
    vertical: false,
    ticks: 8,
    markers: [0.25, 0.5, 0.75],
    snap: 0.03,
    color: '#e9edf8',
    label: 'Crossfader'
  });
  el.querySelector('.js-xf').appendChild(xf.el);

  const curveSeg = segParam(
    params,
    'xf.curve',
    [
      { label: 'SLOW', value: 'slow' },
      { label: 'SMOOTH', value: 'smooth' },
      { label: 'SHARP', value: 'sharp' }
    ],
    'smooth'
  );
  el.querySelector('.js-curve').replaceWith(curveSeg.el);
  curveSeg.el.style.setProperty('--deck-color', '#e9edf8');
  curveSeg.el.style.maxWidth = '170px';

  const snapBtn = el.querySelector('.js-snap');
  snapBtn.classList.add('snap-toggle');
  const reflectSnap = (on) => {
    snapBtn.classList.toggle('on', !!on);
    snapBtn.setAttribute('aria-pressed', String(!!on));
    xf.setSnapEnabled(!!on);
  };
  snapBtn.addEventListener('click', () => params.set('xf.snap', !params.get('xf.snap', true)));
  params.subscribe('xf.snap', reflectSnap);
  reflectSnap(params.get('xf.snap', true));

  return {
    el,
    update() {
      for (const m of meters) {
        m.meter.draw(m.deck.level);
        m.cueBtn.classList.toggle('on', m.deck.cueOn);
        const label = m.deck.title || 'empty';
        if (m.name.textContent !== label) m.name.textContent = label;
      }
    },
    resize() {
      for (const m of meters) m.meter.resize();
    }
  };
}

export function buildMaster(app) {
  const { engine, params } = app;

  const el = document.createElement('aside');
  el.className = 'panel master-col';
  el.innerHTML = `
    <div class="panel-title">Master</div>
    <canvas class="spectrum"></canvas>
    <div class="master-row">
      <canvas class="meter"></canvas>
      <div class="js-master-gain"></div>
    </div>
    <div class="panel-title">Headphones</div>
    <div class="cue-block js-cue-block"></div>`;

  el.querySelector('.js-master-gain').appendChild(
    knobParam(params, 'master.gain', {
      label: 'MASTER',
      min: 0,
      max: 1.2,
      default: 0.85,
      size: 58,
      color: '#e9edf8',
      format: (v) => `${(20 * Math.log10(Math.max(0.001, v))).toFixed(1)}`
    }).el
  );

  const cueBlock = el.querySelector('.js-cue-block');
  cueBlock.appendChild(
    knobParam(params, 'master.cueMix', {
      label: 'CUE MIX',
      min: 0,
      max: 1,
      default: 0,
      size: 48,
      color: '#fbbf24',
      format: (v) => (v < 0.02 ? 'CUE' : v > 0.98 ? 'MST' : `${(v * 100) | 0}`)
    }).el
  );
  cueBlock.appendChild(
    knobParam(params, 'master.phones', {
      label: 'PHONES',
      min: 0,
      max: 1.4,
      default: 0.7,
      size: 48,
      color: '#fbbf24',
      format: (v) => `${(v * 71) | 0}`
    }).el
  );

  const masterMeter = new Meter(el.querySelector('canvas.meter'));
  const spectrum = new Spectrum(el.querySelector('canvas.spectrum'), engine.analyser, [
    '#22d3ee',
    '#a78bfa',
    '#f472b6'
  ]);

  return {
    el,
    update() {
      spectrum.draw();
      masterMeter.draw(app.masterLevel);
    },
    resize() {
      spectrum.resize();
      masterMeter.resize();
    }
  };
}

/** Single-window layout: the three mixer sections side by side. */
export function buildMixer(root, app) {
  root.innerHTML = '';
  const sections = [buildFxRack(app), buildChannels(app), buildMaster(app)];
  for (const s of sections) root.appendChild(s.el);
  return {
    update() {
      for (const s of sections) s.update();
    },
    resize() {
      for (const s of sections) s.resize();
    }
  };
}
