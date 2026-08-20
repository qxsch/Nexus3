import { readFileSync } from 'node:fs';

const DEFAULTS = {
  musicRoot: null,
  scan: 'auto',
  watch: false,
  layout: 'single',
  detached: [],
  alwaysOnTop: false,
  windows: {}
};

/**
 * Desktop shell state. Lives in the `desktop` object of config.json: read directly
 * before the server starts, written through the server's Config instance afterwards.
 */
export class DesktopStore {
  constructor(configFile, panelIds = []) {
    this.configFile = configFile;
    this.panelIds = panelIds;
    this.config = null;
    let raw;
    try {
      raw = JSON.parse(readFileSync(configFile, 'utf8')).desktop;
    } catch {
      raw = null;
    }
    this.data = this.#sanitise(raw);
  }

  #sanitise(raw) {
    const data = { ...DEFAULTS, ...(raw ?? {}) };
    data.layout = data.layout === 'multi' ? 'multi' : 'single';
    data.detached = Array.isArray(data.detached)
      ? data.detached.filter((id) => !this.panelIds.length || this.panelIds.includes(id))
      : [];
    data.alwaysOnTop = !!data.alwaysOnTop;
    data.windows = data.windows && typeof data.windows === 'object' ? data.windows : {};
    return data;
  }

  /** Once the server is up its Config instance owns the file. */
  attach(config, panelIds) {
    this.config = config;
    if (panelIds) this.panelIds = panelIds;
    this.data = this.#sanitise({ ...config.get().desktop, ...this.data });
  }

  get() {
    return this.data;
  }

  patch(patch) {
    this.data = this.#sanitise({ ...this.data, ...patch });
    try {
      this.config?.update({ desktop: this.data });
    } catch (err) {
      console.warn(`desktop settings not saved: ${err.message}`);
    }
    return this.data;
  }

  rememberBounds(id, bounds) {
    this.patch({ windows: { ...this.data.windows, [id]: bounds } });
  }
}
