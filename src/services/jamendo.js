import { config } from './config.js';

const API = 'https://api.jamendo.com/v3.0';
const KEY_STORAGE = 'nx3.jamendo.clientId';

/**
 * Jamendo catalogue adapter. The audio CDN sends CORS headers, so tracks are
 * fetched and decoded directly in the browser and get the full deck feature set.
 */
export const jamendo = {
  clientId: '',

  /** Reads the key from the server settings file, or localStorage on a static host. */
  async init() {
    const loaded = await config.load();
    this.clientId = config.available
      ? (loaded?.jamendoClientId ?? '')
      : (localStorage.getItem(KEY_STORAGE) ?? '');
    return this.clientId;
  },

  async setClientId(value) {
    const next = String(value ?? '').trim();
    if (!config.available) {
      localStorage.setItem(KEY_STORAGE, next);
      this.clientId = next;
      return this.clientId;
    }
    const saved = await config.save({ jamendoClientId: next });
    this.clientId = saved.jamendoClientId ?? '';
    return this.clientId;
  },

  get configured() {
    return this.clientId.length > 0;
  },

  get storageLabel() {
    return config.available ? 'config.json on the server' : 'this browser only';
  },

  async search(query, options = {}, signal) {
    if (!this.configured) throw new Error('Add your Jamendo client ID first');
    const { limit = 40, offset = 0, tags = '', remixSafe = true, audioFormat = 'mp32' } = options;

    const params = new URLSearchParams({
      client_id: this.clientId,
      format: 'json',
      limit: String(Math.min(200, limit)),
      offset: String(offset),
      audioformat: audioFormat,
      include: 'licenses musicinfo',
      // Jamendo returns only album tracks unless singles are asked for explicitly.
      type: 'single albumtrack'
    });
    if (tags) params.set('fuzzytags', tags);
    if (remixSafe) params.set('ccnd', 'false');

    // Relevance ordering and artist grouping only work alongside a query; combined
    // with the licence filter on an empty query Jamendo returns nothing at all.
    if (query) {
      params.set('search', query);
      params.set('order', 'relevance');
      params.set('boost', 'popularity_month');
      params.set('groupby', 'artist_id');
    } else {
      params.set('order', 'popularity_month');
    }

    const res = await fetch(`${API}/tracks/?${params}`, { signal });
    if (!res.ok) throw new Error(`Jamendo returned ${res.status}`);
    const body = await res.json();
    if (body.headers?.status !== 'success') {
      throw new Error(body.headers?.error_message || 'Jamendo request failed');
    }
    return {
      items: (body.results ?? []).map(normalise),
      count: body.headers?.results_count ?? 0
    };
  }
};

function normalise(row) {
  return {
    sourceId: 'jamendo',
    id: String(row.id),
    title: row.name ?? 'Untitled',
    artist: row.artist_name ?? 'Unknown artist',
    album: row.album_name || null,
    durationSec: Number(row.duration) || 0,
    artworkUrl: row.image || row.album_image || '',
    audioUrl: row.audio,
    downloadAllowed: !!row.audiodownload_allowed,
    pageUrl: row.shareurl || `https://www.jamendo.com/track/${row.id}`,
    license: licenseLabel(row.license_ccurl),
    licenseUrl: row.license_ccurl || '',
    tags: [row.musicinfo?.tags?.genres ?? []].flat().slice(0, 3)
  };
}

function licenseLabel(url) {
  if (!url) return 'CC';
  const m = /creativecommons\.org\/licenses\/([a-z-]+)\//i.exec(url);
  return m ? `CC ${m[1].toUpperCase()}` : 'CC';
}

export function jamendoFileName(track) {
  const base = `${track.artist} - ${track.title} [${track.id}]`.replace(/[\\/:*?"<>|]+/g, ' ');
  return `${base.replace(/\s+/g, ' ').trim().slice(0, 150)}.mp3`;
}
