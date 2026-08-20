import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 3;

const FTS_DDL = `CREATE VIRTUAL TABLE tracks_fts USING fts5(
  name, artist, title, album, folder,
  content='', contentless_delete=1,
  tokenize="unicode61 remove_diacritics 2"
)`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS dirs (
  id        INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES dirs(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  rel_path  TEXT NOT NULL UNIQUE,
  depth     INTEGER NOT NULL DEFAULT 0,
  mtime_ms  INTEGER NOT NULL DEFAULT 0,
  n_tracks  INTEGER NOT NULL DEFAULT 0,
  n_total   INTEGER NOT NULL DEFAULT 0,
  seen      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dirs_parent ON dirs(parent_id, name);
CREATE INDEX IF NOT EXISTS idx_dirs_depth ON dirs(depth);

CREATE TABLE IF NOT EXISTS tracks (
  id          INTEGER PRIMARY KEY,
  dir_id      INTEGER NOT NULL REFERENCES dirs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  ext         TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  mtime_ms    INTEGER NOT NULL DEFAULT 0,
  title       TEXT,
  artist      TEXT,
  album       TEXT,
  year        INTEGER,
  duration_ms INTEGER,
  tags_state  INTEGER NOT NULL DEFAULT 0,
  source      TEXT,
  source_id   TEXT,
  license     TEXT,
  page_url    TEXT,
  UNIQUE (dir_id, name)
);
CREATE INDEX IF NOT EXISTS idx_tracks_dir ON tracks(dir_id, name);

CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  name, artist, title, album, folder,
  content='', contentless_delete=1,
  tokenize="unicode61 remove_diacritics 2"
);
CREATE TABLE IF NOT EXISTS analysis (
  track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  bpm         REAL,
  beat_offset REAL,
  duration    REAL,
  bucket_size INTEGER,
  peaks       BLOB,
  bytes       INTEGER NOT NULL DEFAULT 0,
  last_used   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_analysis_used ON analysis(last_used);
`;

export function openDatabase(file, { readOnly = false } = {}) {
  const db = new DatabaseSync(file, { readOnly });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 8000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA cache_size = -65536');
  db.exec('PRAGMA temp_store = MEMORY');
  if (!readOnly) {
    db.exec(SCHEMA);
    const installed = Number(getMeta(db, 'schema_version') ?? 0);
    if (installed < SCHEMA_VERSION) {
      migrate(db, installed);
      setMeta(db, 'schema_version', SCHEMA_VERSION);
    }
  }
  return db;
}

// v2 rebuilds the search index: before it, dropping a folder cascade-deleted its
// tracks but left their contentless FTS rows behind as orphans.
// v3 adds provenance columns so imported tracks keep their licence and backlink.
function migrate(db, from) {
  if (from < 2) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DROP TABLE IF EXISTS tracks_fts');
      db.exec(FTS_DDL);
      db.exec(`INSERT INTO tracks_fts (rowid, name, artist, title, album, folder)
               SELECT t.id, t.name, t.artist, t.title, t.album, d.rel_path
               FROM tracks t JOIN dirs d ON d.id = t.dir_id`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  if (from < 3) {
    for (const column of ['source TEXT', 'source_id TEXT', 'license TEXT', 'page_url TEXT']) {
      try {
        db.exec(`ALTER TABLE tracks ADD COLUMN ${column}`);
      } catch {
        // already present on a freshly created schema
      }
    }
    backfillJamendoProvenance(db);
  }
}

// Archived files are named "<artist> - <title> [<jamendo id>].mp3", which is enough
// to restore the backlink for tracks imported before provenance was stored.
function backfillJamendoProvenance(db) {
  const rows = db
    .prepare(
      `SELECT t.id, t.name FROM tracks t JOIN dirs d ON d.id = t.dir_id
       WHERE (d.rel_path = 'jamendo' OR d.rel_path LIKE 'jamendo/%') AND t.source IS NULL`
    )
    .all();
  if (!rows.length) return;
  const update = db.prepare('UPDATE tracks SET source = ?, source_id = ?, page_url = ? WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const match = /\[(\d+)\]\.[^.]+$/.exec(row.name);
      if (!match) continue;
      update.run('jamendo', match[1], `https://www.jamendo.com/track/${match[1]}`, row.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getMeta(db, key) {
  return db.prepare('SELECT v FROM meta WHERE k = ?').get(key)?.v ?? null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(key, String(value));
}

const TRACK_COLUMNS = `t.id, t.name, t.ext, t.size, t.duration_ms, t.title, t.artist, t.album,
              t.tags_state, t.source, t.source_id, t.license, t.page_url, d.rel_path AS folder`;

/** Read-side queries used by the HTTP layer. Prepared once and reused. */
export class LibraryQueries {
  constructor(db) {
    this.db = db;
    this.qRootDirs = db.prepare(
      `SELECT id, name, rel_path, depth, n_tracks, n_total FROM dirs
       WHERE parent_id IS NULL ORDER BY name COLLATE NOCASE`
    );
    this.qChildDirs = db.prepare(
      `SELECT id, name, rel_path, depth, n_tracks, n_total FROM dirs
       WHERE parent_id = ? ORDER BY name COLLATE NOCASE`
    );
    this.qDirById = db.prepare('SELECT * FROM dirs WHERE id = ?');
    this.qDirByPath = db.prepare('SELECT * FROM dirs WHERE rel_path = ?');
    this.qTracksInDir = db.prepare(
      `SELECT ${TRACK_COLUMNS}
       FROM tracks t JOIN dirs d ON d.id = t.dir_id
       WHERE t.dir_id = ?
       ORDER BY t.name COLLATE NOCASE
       LIMIT ? OFFSET ?`
    );
    this.qTracksUnder = db.prepare(
      `SELECT ${TRACK_COLUMNS}
       FROM tracks t JOIN dirs d ON d.id = t.dir_id
       WHERE d.rel_path = ? OR d.rel_path LIKE ? ESCAPE '\\'
       ORDER BY d.rel_path COLLATE NOCASE, t.name COLLATE NOCASE
       LIMIT ? OFFSET ?`
    );
    this.qAllTracks = db.prepare(
      `SELECT ${TRACK_COLUMNS}
       FROM tracks t JOIN dirs d ON d.id = t.dir_id
       ORDER BY d.rel_path COLLATE NOCASE, t.name COLLATE NOCASE
       LIMIT ? OFFSET ?`
    );
    this.qTrack = db.prepare(
      `SELECT t.*, d.rel_path AS folder FROM tracks t JOIN dirs d ON d.id = t.dir_id WHERE t.id = ?`
    );
    this.qCounts = db.prepare(
      'SELECT (SELECT COUNT(*) FROM tracks) AS tracks, (SELECT COUNT(*) FROM dirs) AS dirs'
    );
    this.qSearch = db.prepare(
      `SELECT ${TRACK_COLUMNS}
       FROM tracks_fts
       JOIN tracks t ON t.id = tracks_fts.rowid
       JOIN dirs   d ON d.id = t.dir_id
       WHERE tracks_fts MATCH ?
       ORDER BY rank
       LIMIT ? OFFSET ?`
    );
    this.qSearchScoped = db.prepare(
      `SELECT ${TRACK_COLUMNS}
       FROM tracks_fts
       JOIN tracks t ON t.id = tracks_fts.rowid
       JOIN dirs   d ON d.id = t.dir_id
       WHERE tracks_fts MATCH ? AND (d.rel_path = ? OR d.rel_path LIKE ? ESCAPE '\\')
       ORDER BY rank
       LIMIT ? OFFSET ?`
    );
    this.qSearchCount = db.prepare(
      `SELECT COUNT(*) AS n FROM
         (SELECT tracks_fts.rowid FROM tracks_fts
          JOIN tracks t ON t.id = tracks_fts.rowid
          WHERE tracks_fts MATCH ? LIMIT 5001)`
    );
    this.qAnalysis = db.prepare('SELECT * FROM analysis WHERE track_id = ?');
    this.qTouchAnalysis = db.prepare('UPDATE analysis SET last_used = ? WHERE track_id = ?');
    this.qPutAnalysis = db.prepare(
      `INSERT OR REPLACE INTO analysis
         (track_id, bpm, beat_offset, duration, bucket_size, peaks, bytes, last_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.qAnalysisCount = db.prepare('SELECT COUNT(*) AS n FROM analysis');
    this.qEvictAnalysis = db.prepare(
      `DELETE FROM analysis WHERE track_id IN
         (SELECT track_id FROM analysis ORDER BY last_used ASC LIMIT ?)`
    );
    this.qSetTags = db.prepare(
      `UPDATE tracks SET title = ?, artist = ?, album = ?, year = ?, duration_ms = ?, tags_state = ?
       WHERE id = ?`
    );
    this.qFtsDelete = db.prepare('DELETE FROM tracks_fts WHERE rowid = ?');
    this.qFtsInsert = db.prepare(
      'INSERT INTO tracks_fts (rowid, name, artist, title, album, folder) VALUES (?, ?, ?, ?, ?, ?)'
    );
  }

  counts() {
    return this.qCounts.get();
  }

  children(parentId) {
    return parentId == null ? this.qRootDirs.all() : this.qChildDirs.all(parentId);
  }

  dir(id) {
    return this.qDirById.get(id);
  }

  tracks(dirId, offset, limit) {
    return this.qTracksInDir.all(dirId, limit, offset);
  }

  /** Every track in a folder and all of its subfolders. */
  tracksUnder(relPath, offset, limit) {
    if (!relPath) return this.qAllTracks.all(limit, offset);
    return this.qTracksUnder.all(relPath, escapeLike(relPath) + '/%', limit, offset);
  }

  track(id) {
    return this.qTrack.get(id);
  }

  search(query, { dirPath = null, offset = 0, limit = 200 } = {}) {
    const match = toMatchExpression(query);
    if (!match) return { items: [], approxTotal: 0 };
    const items = dirPath
      ? this.qSearchScoped.all(match, dirPath, escapeLike(dirPath) + '/%', limit, offset)
      : this.qSearch.all(match, limit, offset);
    const approxTotal = dirPath ? null : this.qSearchCount.get(match).n;
    return { items, approxTotal };
  }

  analysis(id) {
    const row = this.qAnalysis.get(id);
    if (row) this.qTouchAnalysis.run(Date.now(), id);
    return row;
  }

  putAnalysis(id, { bpm, beatOffset, duration, bucketSize, peaks }, cap) {
    this.qPutAnalysis.run(
      id,
      bpm ?? null,
      beatOffset ?? null,
      duration ?? null,
      bucketSize ?? null,
      peaks,
      peaks?.byteLength ?? 0,
      Date.now()
    );
    if (cap > 0) {
      const n = this.qAnalysisCount.get().n;
      if (n > cap) this.qEvictAnalysis.run(n - cap);
    }
  }

  setTags(id, tags) {
    this.qSetTags.run(
      tags.title ?? null,
      tags.artist ?? null,
      tags.album ?? null,
      tags.year ?? null,
      tags.durationMs ?? null,
      tags.state ?? 1,
      id
    );
    const row = this.qTrack.get(id);
    if (!row) return;
    this.qFtsDelete.run(id);
    this.qFtsInsert.run(id, row.name, row.artist, row.title, row.album, row.folder);
  }
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * Turns free text into a safe FTS5 prefix query. Every token is quoted, which
 * neutralises FTS operator syntax, and suffixed with * for type-ahead matching.
 */
export function toMatchExpression(input) {
  const tokens = String(input ?? '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}
