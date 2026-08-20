import { library } from './library.js';
import { jamendoFileName } from './jamendo.js';
import { encodeAnalysis, decodeAnalysis } from './analysisCodec.js';

const CACHE_LIMIT = 6;
const cache = new Map();

function remember(key, bytes) {
  if (!key) return;
  cache.delete(key);
  cache.set(key, bytes);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

/** Downloads the whole file up front; playback never streams, so scratching stays exact. */
async function fetchBytes(url, onProgress, signal) {
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(`download failed from ${new URL(url, location.href).host}`);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || 0;

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress({ phase: 'download', loaded: buf.byteLength, total: buf.byteLength });
    return buf;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ phase: 'download', loaded, total });
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const PROVIDERS = { jamendo: 'Jamendo' };

function describe(source) {
  if (source.kind === 'file') return { title: source.file.name.replace(/\.[^.]+$/, ''), artist: null };
  if (source.kind === 'library') {
    const t = source.track;
    return {
      title: t.title || t.name.replace(/\.[^.]+$/, ''),
      artist: t.artist ?? null,
      libraryId: t.id,
      provider: PROVIDERS[t.source] ?? null,
      license: t.license ?? null,
      pageUrl: t.pageUrl ?? null
    };
  }
  if (source.kind === 'jamendo') {
    return {
      title: source.track.title,
      artist: source.track.artist,
      provider: 'Jamendo',
      license: source.track.license,
      pageUrl: source.track.pageUrl
    };
  }
  return { title: source.title ?? source.url, artist: null };
}

/**
 * Fetches, decodes and mounts a track on a deck. Reuses the server-side
 * analysis cache when the track is already known so BPM and waveform are instant.
 */
export async function loadSource(ctx, deck, source, onProgress = () => {}) {
  const info = describe(source);
  let bytes;
  let cacheKey = null;
  let libraryId = info.libraryId ?? null;

  if (source.kind === 'file') {
    onProgress({ phase: 'download', loaded: 0, total: source.file.size });
    bytes = new Uint8Array(await source.file.arrayBuffer());
    onProgress({ phase: 'download', loaded: bytes.byteLength, total: bytes.byteLength });
  } else if (source.kind === 'jamendo') {
    // The server fetches and archives it, then we read it back as a local file. Going
    // through the browser breaks whenever the CDN serves a cached CORS header that
    // belongs to a different client.
    onProgress({ phase: 'download', loaded: 0, total: 0 });
    let url = source.track.audioUrl;
    try {
      const saved = await library.importFromUrl(source.track.audioUrl, {
        folder: 'jamendo',
        name: jamendoFileName(source.track),
        artist: source.track.artist,
        title: source.track.title,
        source: 'jamendo',
        sourceId: source.track.id,
        license: source.track.license,
        pageUrl: source.track.pageUrl
      });
      libraryId = saved.id;
      url = library.mediaUrl(saved.id);
    } catch (err) {
      console.warn('server-side Jamendo download unavailable, trying the CDN directly', err);
    }
    cacheKey = `jamendo:${url}`;
    bytes = cache.get(cacheKey) ?? (await fetchBytes(url, onProgress, source.signal));
    remember(cacheKey, bytes);
  } else {
    const url = source.kind === 'library' ? library.mediaUrl(source.track.id) : source.url;
    cacheKey = `${source.kind}:${url}`;
    const hit = cache.get(cacheKey);
    if (hit) {
      bytes = hit;
      onProgress({ phase: 'download', loaded: bytes.byteLength, total: bytes.byteLength, cached: true });
    } else {
      bytes = await fetchBytes(url, onProgress, source.signal);
      remember(cacheKey, bytes);
    }
  }

  let cachedAnalysis = null;
  if (libraryId != null) {
    try {
      const stored = await library.getAnalysis(libraryId);
      if (stored) cachedAnalysis = decodeAnalysis(stored.bytes);
    } catch {}
  }

  onProgress({ phase: 'decode' });
  const audio = await ctx.decodeAudioData(bytes.slice().buffer);

  onProgress({ phase: cachedAnalysis ? 'ready' : 'analyse' });
  await deck.load(audio, info.title, {
    analysis: cachedAnalysis,
    meta: {
      sourceId: source.kind,
      libraryId,
      artist: info.artist,
      provider: info.provider ?? null,
      license: info.license ?? null,
      pageUrl: info.pageUrl ?? null
    }
  });

  if (!cachedAnalysis && libraryId != null && deck.analysis) {
    try {
      await library.putAnalysis(
        libraryId,
        {
          bpm: deck.analysis.bpm,
          beatOffset: deck.analysis.beatOffset,
          duration: deck.analysis.duration,
          bucketSize: deck.analysis.bucketSize
        },
        encodeAnalysis(deck.analysis)
      );
    } catch (err) {
      console.warn('could not cache the analysis', err);
    }
  }

  onProgress({ phase: 'ready' });
  return { libraryId, title: info.title };
}
