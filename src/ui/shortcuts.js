const DECK_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2 };
const CUE_KEYS = { KeyQ: 0, KeyW: 1, KeyE: 2 };
const SYNC_KEYS = { KeyA: 0, KeyS: 1, KeyD: 2 };
const PFL_KEYS = { KeyZ: 0, KeyX: 1, KeyC: 2 };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Attached in every window, so the shortcuts work wherever the focus is. */
export function wireKeyboard(app) {
  const held = new Set();
  const help = () => document.querySelector('#help');

  addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (e.code in DECK_KEYS) {
      e.preventDefault();
      app.decks[DECK_KEYS[e.code]].toggle();
    } else if (e.code in CUE_KEYS) {
      if (held.has(e.code)) return;
      held.add(e.code);
      e.preventDefault();
      app.decks[CUE_KEYS[e.code]].pressCue();
    } else if (e.code in SYNC_KEYS) {
      e.preventDefault();
      app.sync.toggleSync(app.decks[SYNC_KEYS[e.code]]);
    } else if (e.code in PFL_KEYS) {
      e.preventDefault();
      const d = app.decks[PFL_KEYS[e.code]];
      d.setCue(!d.cueOn);
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      const delta = e.code === 'ArrowLeft' ? -0.04 : 0.04;
      app.params.set('xf.value', clamp01(app.params.get('xf.value', 0.5) + delta));
    } else if (e.key === '?') {
      help()?.classList.toggle('hidden');
    } else if (e.code === 'Escape') {
      help()?.classList.add('hidden');
    }
  });

  addEventListener('keyup', (e) => {
    if (e.code in CUE_KEYS) {
      held.delete(e.code);
      app.decks[CUE_KEYS[e.code]].releaseCue();
    }
  });
}
