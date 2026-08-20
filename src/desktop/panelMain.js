import { Bus, requestWelcome } from './bus.js';
import { createSharedState } from './sharedState.js';
import { RemoteApp } from './remote.js';
import { panelById } from './panels.js';
import { DeckPanel } from '../ui/deckPanel.js';
import { buildChannels, buildFxRack, buildMaster } from '../ui/mixerPanel.js';
import { CratePanel } from '../ui/cratePanel.js';
import { wireKeyboard } from '../ui/shortcuts.js';
import { jamendo } from '../services/jamendo.js';

function fail(root, message) {
  root.innerHTML = `<div class="panel-wait"><b>Panel disconnected</b><p>${message}</p></div>`;
}

/**
 * The height the panel wants once it stops stretching to the window. Widths are not
 * measured: knobs and faders paint outside their own box by design, so every container
 * that wraps one reports an overflow that nothing actually clips.
 */
function measurePanelHeight(root) {
  const panel = root.firstElementChild;
  if (!panel) return null;

  const previous = { flex: panel.style.flex, height: panel.style.height };
  panel.style.flex = 'none';
  panel.style.height = 'auto';
  const natural = panel.getBoundingClientRect().height;
  panel.style.flex = previous.flex;
  panel.style.height = previous.height;

  const pad = getComputedStyle(root.parentElement);
  return Math.ceil(natural + parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom));
}

/** Bootstraps one detached panel window against the console window's audio engine. */
export async function startPanel(id) {
  const meta = panelById(id);
  const root = document.querySelector('#panel-root');
  document.body.classList.add('panel-mode');
  document.body.dataset.panel = id;

  if (!meta) return fail(root, `Unknown panel "${id}".`);
  document.title = `NEXUS\u00b73: ${meta.title}`;
  root.innerHTML = `<div class="panel-wait"><b>${meta.title}</b><p>Waiting for the console window\u2026</p></div>`;

  let welcome;
  try {
    welcome = await requestWelcome(id);
  } catch (err) {
    return fail(root, err.message);
  }

  const state = createSharedState(welcome.sab);
  const bus = new Bus(`panel:${id}`);
  const app = new RemoteApp({ state, bus, cold: welcome.cold });
  root.innerHTML = '';

  let section;
  if (meta.deck !== undefined) {
    const wrap = document.createElement('div');
    wrap.className = 'decks';
    const panel = new DeckPanel(app.decks[meta.deck], app);
    wrap.appendChild(panel.el);
    root.appendChild(wrap);
    app.requestAnalysis(meta.deck);
    section = panel;
  } else if (id === 'crate') {
    await jamendo.init().catch(() => {});
    root.classList.add('crate');
    app.crate = new CratePanel(root, app);
    bus.on('refresh-crate', () => app.crate.refreshTree());
    section = { update() {}, resize() {} };
  } else {
    const build = { fx: buildFxRack, channels: buildChannels, master: buildMaster }[id];
    section = build(app);
    root.appendChild(section.el);
  }

  bus.send('panel-open', { id });
  // A reloaded console window means a new engine and a new shared buffer.
  bus.on('host-ready', () => location.reload());
  addEventListener('pagehide', () => bus.send('panel-closed', { id }));

  wireKeyboard(app);

  requestAnimationFrame(() => section.resize?.());
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const height = measurePanelHeight(root);
      if (height) window.nexus?.fitWindow?.({ height });
    })
  );

  let resizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => section.resize?.(), 120);
  });

  const frame = (now) => {
    app.tick();
    section.update?.(now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
