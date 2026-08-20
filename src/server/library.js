import { Worker } from 'node:worker_threads';
import { watch } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, sep, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { openDatabase, LibraryQueries, getMeta } from './db.js';
import { readTags } from './tags.js';

const SCANNER_URL = new URL('./scanner.worker.js', import.meta.url);

export class Library {
  constructor(options) {
    this.options = options;
    this.db = openDatabase(options.dbFile);
    this.q = new LibraryQueries(this.db);
    this.subscribers = new Set();
    this.worker = null;
    this.watcher = null;
    this.watchTimer = null;

    this.status = {
      root: options.musicRoot,
      state: 'idle',
      scannedFiles: 0,
      scannedDirs: 0,
      added: 0,
      updated: 0,
      removed: 0,
      currentPath: '',
      elapsedMs: 0,
      lastScan: Number(getMeta(this.db, 'last_scan') ?? 0),
      error: null,
      ...this.q.counts()
    };

    this.write = {
      dirByPath: this.db.prepare('SELECT id FROM dirs WHERE rel_path = ?'),
      insertDir: this.db.prepare(
        'INSERT INTO dirs (parent_id, name, rel_path, depth, mtime_ms) VALUES (?, ?, ?, ?, ?)'
      ),
      bumpDir: this.db.prepare(
        'UPDATE dirs SET n_tracks = n_tracks + 1, n_total = n_total + 1 WHERE id = ?'
      ),
      bumpTotal: this.db.prepare('UPDATE dirs SET n_total = n_total + 1 WHERE id = ?'),
      parentOf: this.db.prepare('SELECT parent_id FROM dirs WHERE id = ?'),
      trackByName: this.db.prepare('SELECT id FROM tracks WHERE dir_id = ? AND name = ?'),
      insertTrack: this.db.prepare(
        `INSERT INTO tracks (dir_id, name, ext, size, mtime_ms, title, artist, tags_state,
                             source, source_id, license, page_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
      ),
      ftsInsert: this.db.prepare(
        'INSERT INTO tracks_fts (rowid, name, artist, title, album, folder) VALUES (?, ?, ?, ?, ?, ?)'
      ),
      missingLicense: this.db.prepare(
        `SELECT id, source_id FROM tracks
         WHERE source = 'jamendo' AND source_id IS NOT NULL AND license IS NULL
         LIMIT ?`
      ),
      setLicense: this.db.prepare('UPDATE tracks SET license = ?, page_url = COALESCE(page_url, ?) WHERE id = ?')
    };
  }

  // ------------------------------------------------------------------ status

  subscribe(res) {
    this.subscribers.add(res);
    res.on('close', () => this.subscribers.delete(res));
    this.push();
  }

  push() {
    if (!this.subscribers.size) return;
    const payload = `data: ${JSON.stringify(this.status)}\n\n`;
    for (const res of this.subscribers) {
      try {
        res.write(payload);
      } catch {
        this.subscribers.delete(res);
      }
    }
  }

  refreshCounts() {
    Object.assign(this.status, this.q.counts());
  }

  // ------------------------------------------------------------------- scan

  startScan(mode = this.options.scan) {
    if (mode === 'off' || this.worker) return this.status;
    const startedAt = Date.now();
    Object.assign(this.status, {
      state: 'scanning',
      scannedFiles: 0,
      scannedDirs: 0,
      added: 0,
      updated: 0,
      removed: 0,
      currentPath: '',
      elapsedMs: 0,
      error: null
    });
    this.push();

    this.worker = new Worker(SCANNER_URL, {
      workerData: {
        dbFile: this.options.dbFile,
        musicRoot: this.options.musicRoot,
        mode,
        concurrency: this.options.scanConcurrency,
        audioExtensions: [...this.options.audioExtensions]
      }
    });

    this.worker.on('message', (msg) => {
      if (msg.type === 'progress' || msg.type === 'done') {
        Object.assign(this.status, {
          scannedFiles: msg.files,
          scannedDirs: msg.dirs,
          added: msg.added,
          updated: msg.updated,
          removed: msg.removed,
          currentPath: msg.currentPath ?? this.status.currentPath,
          elapsedMs: msg.elapsedMs ?? Date.now() - startedAt
        });
        if (msg.type === 'done') {
          this.status.state = 'idle';
          this.status.lastScan = Date.now();
          this.status.currentPath = '';
          this.refreshCounts();
        }
        this.push();
      } else if (msg.type === 'error') {
        this.status.state = 'error';
        this.status.error = msg.message;
        this.push();
      }
    });

    const finish = () => {
      this.worker = null;
      if (this.status.state === 'scanning') this.status.state = 'idle';
      this.refreshCounts();
      this.push();
    };
    this.worker.on('error', (err) => {
      this.status.state = 'error';
      this.status.error = err.message;
      finish();
    });
    this.worker.on('exit', finish);
    return this.status;
  }

  startWatching() {
    if (!this.options.watch || this.watcher) return;
    try {
      this.watcher = watch(this.options.musicRoot, { recursive: true }, () => {
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => this.startScan('auto'), 2500);
      });
    } catch (err) {
      console.warn(`  watch disabled: ${err.message}`);
    }
  }

  // ------------------------------------------------------------------ reads

  tree(parentId) {
    return this.q.children(parentId).map(shapeDir);
  }

  folder(id, offset, limit, recursive = true) {
    const dir = this.q.dir(id);
    if (!dir) return null;
    const shaped = shapeDir(dir);
    const items = recursive
      ? this.q.tracksUnder(dir.rel_path, offset, limit)
      : this.q.tracks(id, offset, limit);
    return {
      dir: shaped,
      total: recursive ? shaped.total : shaped.tracks,
      items: items.map(shapeTrack),
      offset,
      limit
    };
  }

  search(query, { dirPath, offset, limit }) {
    const result = this.q.search(query, { dirPath, offset, limit });
    return { items: result.items.map(shapeTrack), approxTotal: result.approxTotal, offset, limit };
  }

  track(id) {
    const row = this.q.track(id);
    return row ? shapeTrack(row) : null;
  }

  /** Absolute path for a track id, guaranteed to stay inside the library root. */
  pathFor(id) {
    const row = this.q.track(id);
    if (!row) return null;
    const rel = row.folder ? row.folder.split('/').join(sep) : '';
    const abs = resolve(join(this.options.musicRoot, rel, row.name));
    const root = resolve(this.options.musicRoot);
    if (abs !== root && !abs.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
    return { abs, row: shapeTrack(row) };
  }

  async readTagsFor(ids) {
    const out = [];
    for (const id of ids.slice(0, 100)) {
      const row = this.q.track(id);
      if (!row) continue;
      if (row.tags_state !== 0) {
        out.push(shapeTrack(row));
        continue;
      }
      const located = this.pathFor(id);
      if (!located) continue;
      const tags = await readTags(located.abs, row.ext);
      this.q.setTags(id, tags);
      out.push(shapeTrack(this.q.track(id)));
    }
    return out;
  }

  // --------------------------------------------------------------- analysis

  getAnalysis(id) {
    const row = this.q.analysis(id);
    if (!row?.peaks) return null;
    try {
      return {
        bpm: row.bpm,
        beatOffset: row.beat_offset,
        duration: row.duration,
        bucketSize: row.bucket_size,
        peaks: gunzipSync(Buffer.from(row.peaks.buffer, row.peaks.byteOffset, row.peaks.byteLength))
      };
    } catch {
      return null;
    }
  }

  putAnalysis(id, meta, rawPeaks) {
    if (!this.q.track(id)) return false;
    this.q.putAnalysis(
      id,
      { ...meta, peaks: gzipSync(rawPeaks, { level: 6 }) },
      this.options.analysisCap
    );
    return true;
  }

  // ----------------------------------------------------------------- import

  async importFile({ bytes, folder = 'jamendo', fileName, artist, title, source, sourceId, license, pageUrl }) {
    const safeFolder = sanitizeSegment(folder) || 'imported';
    const safeName = sanitizeSegment(fileName) || `track-${Date.now()}.mp3`;
    const dirAbs = join(this.options.musicRoot, safeFolder);
    await mkdir(dirAbs, { recursive: true });
    const abs = join(dirAbs, safeName);
    await writeFile(abs, bytes);

    const dirId = this.ensureDir(safeFolder);
    const existing = this.write.trackByName.get(dirId, safeName);
    if (existing) return { id: Number(existing.id), path: `${safeFolder}/${safeName}`, existed: true };

    const dot = safeName.lastIndexOf('.');
    const ext = dot > 0 ? safeName.slice(dot).toLowerCase() : '.mp3';
    const info = this.write.insertTrack.run(
      dirId,
      safeName,
      ext,
      bytes.byteLength,
      Date.now(),
      title ?? null,
      artist ?? null,
      source ?? null,
      sourceId ?? null,
      license ?? null,
      safeHttpUrl(pageUrl)
    );
    const id = Number(info.lastInsertRowid);
    this.write.ftsInsert.run(id, safeName, artist ?? null, title ?? null, null, safeFolder);
    this.#bumpCounts(dirId);
    this.refreshCounts();
    this.push();
    return { id, path: `${safeFolder}/${safeName}`, existed: false };
  }

  /** Direct folder gains a track, every ancestor gains a recursive total. */
  #bumpCounts(dirId) {
    this.write.bumpDir.run(dirId);
    let parent = this.write.parentOf.get(dirId)?.parent_id;
    while (parent != null) {
      const id = Number(parent);
      this.write.bumpTotal.run(id);
      parent = this.write.parentOf.get(id)?.parent_id;
    }
  }

  tracksMissingLicense(limit = 200) {
    return this.write.missingLicense.all(limit).map((r) => ({
      id: Number(r.id),
      sourceId: String(r.source_id)
    }));
  }

  setLicense(id, license, pageUrl) {
    this.write.setLicense.run(license ?? null, pageUrl ?? null, id);
  }

  ensureDir(relPath) {    const found = this.write.dirByPath.get(relPath);
    if (found) return Number(found.id);
    const parts = relPath.split('/');
    let parentId = Number(this.write.dirByPath.get('')?.id ?? 0);
    if (!parentId) {
      parentId = Number(this.write.insertDir.run(null, '', '', 0, 0).lastInsertRowid);
    }
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      const row = this.write.dirByPath.get(acc);
      parentId = row
        ? Number(row.id)
        : Number(this.write.insertDir.run(parentId, parts[i], acc, i + 1, 0).lastInsertRowid);
    }
    return parentId;
  }

  close() {
    this.watcher?.close();
    this.worker?.terminate();
    try {
      this.db.close();
    } catch {}
  }
}

function shapeDir(row) {
  return {
    id: Number(row.id),
    name: row.name || '/',
    path: row.rel_path,
    depth: Number(row.depth ?? 0),
    tracks: Number(row.n_tracks ?? 0),
    total: Number(row.n_total ?? 0)
  };
}

function shapeTrack(row) {
  return {
    id: Number(row.id),
    name: row.name,
    ext: row.ext,
    size: Number(row.size ?? 0),
    folder: row.folder ?? '',
    title: row.title ?? null,
    artist: row.artist ?? null,
    album: row.album ?? null,
    durationMs: row.duration_ms ?? null,
    tagged: Number(row.tags_state ?? 0) !== 0,
    source: row.source ?? null,
    sourceId: row.source_id ?? null,
    license: row.license ?? null,
    pageUrl: row.page_url ?? null
  };
}

function sanitizeSegment(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\.\.+/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/** Backlinks end up as hrefs, so only plain web URLs are stored. */
function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
