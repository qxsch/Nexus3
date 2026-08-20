import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULTS = { jamendoClientId: '' };
const CLIENT_ID = /^[A-Za-z0-9_-]{0,64}$/;
const MAX_DESKTOP_BYTES = 64 * 1024;

/** Small JSON settings file next to the app, holding secrets-lite values like API keys. */
export class Config {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this.load();
    if (!this.data.jamendoClientId && process.env.JAMENDO_CLIENT_ID) {
      this.data.jamendoClientId = String(process.env.JAMENDO_CLIENT_ID).trim();
    }
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') Object.assign(this.data, DEFAULTS, parsed);
    } catch (err) {
      console.warn(`  config unreadable (${err.message}), using defaults`);
    }
  }

  get() {
    return { ...this.data };
  }

  update(patch) {
    if (typeof patch?.jamendoClientId === 'string') {
      const value = patch.jamendoClientId.trim();
      if (!CLIENT_ID.test(value)) throw new Error('client ID may only contain letters, digits, - and _');
      this.data.jamendoClientId = value;
    }
    // Desktop shell state (music folder, window layout). Opaque to the server.
    if (patch?.desktop && typeof patch.desktop === 'object' && !Array.isArray(patch.desktop)) {
      const encoded = JSON.stringify(patch.desktop);
      if (encoded.length > MAX_DESKTOP_BYTES) throw new Error('desktop settings are too large');
      this.data.desktop = JSON.parse(encoded);
    }
    this.save();
    return this.get();
  }

  save() {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.config-${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
    renameSync(tmp, this.file);
  }
}
