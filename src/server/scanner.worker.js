import { parentPort, workerData } from 'node:worker_threads';
import { opendir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { openDatabase, setMeta } from './db.js';

const { dbFile, musicRoot, mode, concurrency, audioExtensions } = workerData;
const AUDIO = new Set(audioExtensions);
const COMMIT_EVERY_MS = 300;
const PROGRESS_EVERY_MS = 250;

const db = openDatabase(dbFile);

const stmt = {
  dirByPath: db.prepare('SELECT id, mtime_ms FROM dirs WHERE rel_path = ?'),
  insertDir: db.prepare(
    'INSERT INTO dirs (parent_id, name, rel_path, depth, mtime_ms) VALUES (?, ?, ?, ?, ?)'
  ),
  touchDir: db.prepare('UPDATE dirs SET mtime_ms = ?, n_tracks = ? WHERE id = ?'),
  childDirs: db.prepare('SELECT id, name, rel_path, mtime_ms FROM dirs WHERE parent_id IS ?'),
  deleteDir: db.prepare('DELETE FROM dirs WHERE id = ?'),
  filesInDir: db.prepare('SELECT id, name, size, mtime_ms FROM tracks WHERE dir_id = ?'),
  insertTrack: db.prepare(
    'INSERT INTO tracks (dir_id, name, ext, size, mtime_ms) VALUES (?, ?, ?, ?, ?)'
  ),
  updateTrack: db.prepare(
    'UPDATE tracks SET size = ?, mtime_ms = ?, tags_state = 0 WHERE id = ?'
  ),
  deleteTrack: db.prepare('DELETE FROM tracks WHERE id = ?'),
  ftsInsert: db.prepare(
    'INSERT INTO tracks_fts (rowid, name, artist, title, album, folder) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  ftsDelete: db.prepare('DELETE FROM tracks_fts WHERE rowid = ?'),
  allDirs: db.prepare('SELECT id, parent_id, n_tracks FROM dirs'),
  setTotal: db.prepare('UPDATE dirs SET n_total = ? WHERE id = ?'),
  subtree: db.prepare(
    `WITH RECURSIVE sub(id) AS (
       SELECT ? UNION ALL SELECT d.id FROM dirs d JOIN sub ON d.parent_id = sub.id
     ) SELECT id FROM sub`
  ),
  trackIdsInDir: db.prepare('SELECT id FROM tracks WHERE dir_id = ?')
};

// Deleting a directory cascades to its tracks, but the contentless FTS table has
// no foreign key, so its rows have to go first or they linger as orphans.
function purgeDir(dirId) {
  for (const dir of stmt.subtree.all(dirId)) {
    for (const track of stmt.trackIdsInDir.all(dir.id)) stmt.ftsDelete.run(track.id);
  }
  stmt.deleteDir.run(dirId);
}

let inTransaction = false;
let lastCommit = Date.now();

function begin() {
  if (!inTransaction) {
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
  }
}

function commit(force = false) {
  if (!inTransaction) return;
  if (!force && Date.now() - lastCommit < COMMIT_EVERY_MS) return;
  db.exec('COMMIT');
  inTransaction = false;
  lastCommit = Date.now();
}

const counters = { files: 0, dirs: 0, added: 0, updated: 0, removed: 0 };
let lastProgress = 0;
let currentPath = '';

function reportProgress(force = false) {
  const now = Date.now();
  if (!force && now - lastProgress < PROGRESS_EVERY_MS) return;
  lastProgress = now;
  parentPort.postMessage({ type: 'progress', ...counters, currentPath });
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

function isSkippableDir(name) {
  return name.startsWith('.') || name === 'System Volume Information' || name === '$RECYCLE.BIN';
}

function ensureDirRow(parentId, name, relPath, depth) {
  const existing = stmt.dirByPath.get(relPath);
  if (existing) return { id: Number(existing.id), mtime: Number(existing.mtime_ms), fresh: false };
  const info = stmt.insertDir.run(parentId, name, relPath, depth, 0);
  return { id: Number(info.lastInsertRowid), mtime: -1, fresh: true };
}

async function statSafe(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/**
 * Reconciles one directory against the index. Returns the child directories to
 * descend into. When the directory mtime is unchanged we trust the index and
 * only recurse, which is what keeps a re-scan of a huge library near instant.
 */
async function processDirectory(entry) {
  const abs = entry.relPath ? join(musicRoot, entry.relPath.split('/').join(sep)) : musicRoot;
  const st = await statSafe(abs);
  if (!st) {
    begin();
    purgeDir(entry.id);
    return [];
  }

  const unchanged = mode !== 'full' && entry.mtime === Math.floor(st.mtimeMs) && !entry.fresh;
  currentPath = entry.relPath || '/';
  counters.dirs++;

  if (unchanged) {
    return stmt.childDirs.all(entry.id).map((row) => ({
      id: Number(row.id),
      name: row.name,
      relPath: row.rel_path,
      mtime: Number(row.mtime_ms),
      depth: entry.depth + 1,
      fresh: false
    }));
  }

  const dirents = [];
  try {
    const handle = await opendir(abs);
    for await (const d of handle) dirents.push(d);
  } catch {
    return [];
  }

  const seenDirNames = new Set();
  const children = [];
  const files = [];
  for (const d of dirents) {
    if (d.isDirectory()) {
      if (isSkippableDir(d.name)) continue;
      seenDirNames.add(d.name);
      children.push(d.name);
    } else if (d.isFile() && AUDIO.has(extensionOf(d.name))) {
      files.push(d.name);
    }
  }

  const stats = [];
  const CHUNK = 64;
  for (let i = 0; i < files.length; i += CHUNK) {
    const slice = files.slice(i, i + CHUNK);
    const results = await Promise.all(slice.map((n) => statSafe(join(abs, n))));
    for (let j = 0; j < slice.length; j++) {
      if (results[j]?.isFile()) stats.push({ name: slice[j], st: results[j] });
    }
  }

  begin();

  const existing = new Map();
  if (!entry.fresh) {
    for (const row of stmt.filesInDir.all(entry.id)) existing.set(row.name, row);
  }

  for (const { name, st: fst } of stats) {
    const size = Number(fst.size);
    const mtime = Math.floor(fst.mtimeMs);
    const prev = existing.get(name);
    if (!prev) {
      const info = stmt.insertTrack.run(entry.id, name, extensionOf(name), size, mtime);
      stmt.ftsInsert.run(Number(info.lastInsertRowid), name, null, null, null, entry.relPath);
      counters.added++;
    } else {
      existing.delete(name);
      if (Number(prev.size) !== size || Number(prev.mtime_ms) !== mtime) {
        stmt.updateTrack.run(size, mtime, prev.id);
        stmt.ftsDelete.run(prev.id);
        stmt.ftsInsert.run(prev.id, name, null, null, null, entry.relPath);
        counters.updated++;
      }
    }
    counters.files++;
  }

  for (const stale of existing.values()) {
    stmt.ftsDelete.run(stale.id);
    stmt.deleteTrack.run(stale.id);
    counters.removed++;
  }

  const dbChildren = entry.fresh ? [] : stmt.childDirs.all(entry.id);
  const byName = new Map(dbChildren.map((r) => [r.name, r]));
  const descend = [];
  for (const name of children) {
    const relPath = entry.relPath ? `${entry.relPath}/${name}` : name;
    const row = byName.get(name);
    if (row) {
      byName.delete(name);
      descend.push({
        id: Number(row.id),
        name,
        relPath,
        mtime: Number(row.mtime_ms),
        depth: entry.depth + 1,
        fresh: false
      });
    } else {
      const created = ensureDirRow(entry.id, name, relPath, entry.depth + 1);
      descend.push({ id: created.id, name, relPath, mtime: -1, depth: entry.depth + 1, fresh: true });
    }
  }
  for (const gone of byName.values()) purgeDir(gone.id);

  stmt.touchDir.run(Math.floor(st.mtimeMs), stats.length, entry.id);
  commit();
  reportProgress();
  return descend;
}

function recomputeTotals() {
  const rows = stmt.allDirs.all();
  const kids = new Map();
  const direct = new Map();
  for (const r of rows) {
    const id = Number(r.id);
    direct.set(id, Number(r.n_tracks));
    const parent = r.parent_id == null ? null : Number(r.parent_id);
    if (parent != null) {
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent).push(id);
    }
  }
  const totals = new Map();
  const visit = (id) => {
    if (totals.has(id)) return totals.get(id);
    let sum = direct.get(id) ?? 0;
    for (const child of kids.get(id) ?? []) sum += visit(child);
    totals.set(id, sum);
    return sum;
  };
  for (const r of rows) visit(Number(r.id));
  begin();
  for (const [id, total] of totals) stmt.setTotal.run(total, id);
  commit(true);
}

async function run() {
  const started = Date.now();
  const root = ensureDirRow(null, '', '', 0);
  commit(true);

  const queue = [{ id: root.id, name: '', relPath: '', mtime: root.mtime, depth: 0, fresh: root.fresh }];
  const workers = new Array(concurrency).fill(0).map(async () => {
    while (queue.length) {
      const entry = queue.pop();
      if (!entry) break;
      const children = await processDirectory(entry);
      for (const c of children) queue.push(c);
    }
  });
  await Promise.all(workers);

  commit(true);
  recomputeTotals();
  setMeta(db, 'last_scan', Date.now());
  setMeta(db, 'root', musicRoot);
  reportProgress(true);
  parentPort.postMessage({ type: 'done', ...counters, elapsedMs: Date.now() - started });
}

run()
  .catch((err) => {
    try {
      commit(true);
    } catch {}
    parentPort.postMessage({ type: 'error', message: err?.message ?? String(err) });
  })
  .finally(() => {
    try {
      db.close();
    } catch {}
  });
