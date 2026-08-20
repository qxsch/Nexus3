let cached = null;
let available = true;

/** Server-side settings file. Falls back to localStorage when the API is absent. */
export const config = {
  get available() {
    return available;
  },

  async load() {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error(String(res.status));
      cached = await res.json();
      available = true;
    } catch {
      available = false;
      cached = null;
    }
    return cached;
  },

  get() {
    return cached ?? {};
  },

  async save(patch) {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `save failed (${res.status})`);
    cached = body;
    return cached;
  }
};
