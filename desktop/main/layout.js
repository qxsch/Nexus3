export const PRESETS = {
  decks: { label: 'Decks on second screen', ids: ['deckA', 'deckB', 'deckC'] },
  crate: { label: 'Crate on second screen', ids: ['crate'] },
  all: { label: 'Everything detached', ids: null } // null means every panel
};

/**
 * Owns which boxes live in their own window. The console renderer is the one that can
 * call window.open (panel windows must share its agent cluster for SharedArrayBuffer),
 * so this side decides and the renderer reconciles.
 */
export class LayoutManager {
  constructor({ store, panels, onChanged }) {
    this.store = store;
    this.panels = panels;
    this.onChanged = onChanged;
    this.windows = new Map();
    this.closingOurselves = new Set();
    this.needsFit = new Set();
    this.console = null;
  }

  get state() {
    return this.store.get();
  }

  get detached() {
    return this.state.layout === 'multi' ? this.state.detached : [];
  }

  setConsole(win) {
    this.console = win;
    this.trackBounds(win, 'console');
    win.webContents.on('did-finish-load', () => this.push());
  }

  /** Remembers geometry as it changes, so an unclean shutdown does not lose the layout. */
  trackBounds(win, id) {
    let timer = null;
    const remember = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (win.isDestroyed()) return;
        const b = win.getNormalBounds();
        this.store.rememberBounds(id, { ...b, maximized: win.isMaximized() });
      }, 400);
    };
    win.on('resize', remember);
    win.on('move', remember);
    win.on('maximize', remember);
    win.on('unmaximize', remember);
    win.once('closed', () => clearTimeout(timer));
    remember();
  }

  push() {
    this.console?.webContents.send('nexus:layout', {
      layout: this.state.layout,
      detached: this.detached,
      alwaysOnTop: this.state.alwaysOnTop
    });
    this.onChanged?.();
  }

  setLayout(mode) {
    this.store.patch({ layout: mode === 'multi' ? 'multi' : 'single' });
    this.push();
  }

  togglePanel(id, on) {
    const next = new Set(this.state.detached);
    on ? next.add(id) : next.delete(id);
    this.store.patch({ detached: [...next], layout: next.size ? 'multi' : this.state.layout });
    this.push();
  }

  applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return;
    const ids = preset.ids ?? this.panels.map((p) => p.id);
    this.store.patch({ detached: ids, layout: 'multi' });
    this.push();
  }

  setAlwaysOnTop(on) {
    this.store.patch({ alwaysOnTop: !!on });
    for (const win of [this.console, ...this.windows.values()]) win?.setAlwaysOnTop(!!on);
    this.push();
  }

  reset() {
    this.closeAll();
    this.store.patch({ layout: 'single', detached: [], windows: {}, alwaysOnTop: false });
    this.console?.setAlwaysOnTop(false);
    this.push();
  }

  /** Called from did-create-window once the renderer has opened a panel. */
  adopt(win, id, title) {
    this.windows.set(id, win);
    win.setTitle(`NEXUS-3: ${title}`);
    win.setMenuBarVisibility(false);
    if (this.state.alwaysOnTop) win.setAlwaysOnTop(true);

    const saved = this.state.windows?.[id];
    if (saved?.width && saved?.height) {
      win.setBounds({
        x: saved.x,
        y: saved.y,
        width: saved.width,
        height: saved.height
      });
    } else {
      this.needsFit.add(id);
      win.center();
    }

    this.trackBounds(win, id);
    win.on('closed', () => {
      this.windows.delete(id);
      if (this.closingOurselves.delete(id)) return;
      // Closed with the window button: untick it so the box goes back to the console.
      this.togglePanel(id, false);
    });
  }

  /** Trims a newly detached window down to the height its panel just measured. */
  fitWindow(win, size) {
    const id = [...this.windows].find(([, candidate]) => candidate === win)?.[0];
    if (!id || !this.needsFit.delete(id)) return;

    const meta = this.panels.find((p) => p.id === id);
    const width = win.getContentSize()[0];
    const height = Math.max(Math.round(size?.height) || 0, meta?.minHeight ?? 240);
    win.setContentSize(width, height);
    win.center();
  }

  closeAll() {
    for (const [id, win] of this.windows) {
      this.closingOurselves.add(id);
      if (!win.isDestroyed()) win.destroy();
    }
    this.windows.clear();
  }
}

export function isPanelUrl(url) {
  try {
    return new URL(url).searchParams.get('panel');
  } catch {
    return null;
  }
}
