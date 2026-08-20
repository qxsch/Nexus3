async function json(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const library = {
  mediaUrl(id) {
    return `/media/${id}`;
  },

  status() {
    return json('/api/library/status');
  },

  /** Server-sent scan progress. Returns a disposer. */
  subscribe(onStatus) {
    const es = new EventSource('/api/library/events');
    es.onmessage = (e) => {
      try {
        onStatus(JSON.parse(e.data));
      } catch {}
    };
    return () => es.close();
  },

  dirs(parentId) {
    const q = parentId == null ? '' : `?parent=${parentId}`;
    return json(`/api/library/dirs${q}`).then((r) => r.items);
  },

  folder(id, offset = 0, limit = 200) {
    return json(`/api/library/folder?id=${id}&offset=${offset}&limit=${limit}`);
  },

  search(query, { dir = null, offset = 0, limit = 200, signal } = {}) {
    const params = new URLSearchParams({ q: query, offset: String(offset), limit: String(limit) });
    if (dir) params.set('dir', dir);
    return json(`/api/library/search?${params}`, { signal });
  },

  tags(ids) {
    return json('/api/library/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids })
    }).then((r) => r.items);
  },

  rescan(mode = 'auto') {
    return json('/api/library/rescan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode })
    });
  },

  async getAnalysis(id) {
    const res = await fetch(`/api/library/analysis/${id}`);
    if (res.status !== 200) return null;
    return {
      bpm: Number(res.headers.get('x-bpm')) || 0,
      beatOffset: Number(res.headers.get('x-beat-offset')) || 0,
      duration: Number(res.headers.get('x-duration')) || 0,
      bucketSize: Number(res.headers.get('x-bucket-size')) || 0,
      bytes: new Uint8Array(await res.arrayBuffer())
    };
  },

  putAnalysis(id, meta, bytes) {
    const params = new URLSearchParams({
      bpm: String(meta.bpm ?? 0),
      beatOffset: String(meta.beatOffset ?? 0),
      duration: String(meta.duration ?? 0),
      bucketSize: String(meta.bucketSize ?? 0)
    });
    return fetch(`/api/library/analysis/${id}?${params}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes
    });
  },

  importTrack(bytes, { folder = 'jamendo', name, artist, title, source, sourceId, license, pageUrl }) {
    const params = new URLSearchParams({ folder, name });
    if (artist) params.set('artist', artist);
    if (title) params.set('title', title);
    if (source) params.set('source', source);
    if (sourceId) params.set('sourceId', sourceId);
    if (license) params.set('license', license);
    if (pageUrl) params.set('pageUrl', pageUrl);
    return json(`/api/library/import?${params}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes
    });
  },

  /** Lets the server do the download, which sidesteps the CDN's CORS handling. */
  importFromUrl(url, meta) {
    return json('/api/library/import-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, ...meta })
    });
  }
};
