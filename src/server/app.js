import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { APP_ROOT } from './options.js';
import { Library } from './library.js';
import { Config } from './config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.webm': 'audio/webm'
};

const DENY = [/^\.cache(\/|$)/, /^\.git(\/|$)/, /(^|\/)\.[^/]/, /^config\.json$/, /^desktop(\/|$)/];
const MAX_BODY = 256 * 1024 * 1024;
const MAX_IMPORT_BYTES = 128 * 1024 * 1024;

// The only hosts the server will fetch from on the client's behalf.
const isAllowedImportHost = (hostname) => hostname === 'jamendo.com' || hostname.endsWith('.jamendo.com');

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(payload);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Resolves a request path inside the app folder, rejecting traversal and dot-dirs.
function resolveStatic(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const rel = normalize(decoded).replace(/^([/\\])+/, '').replace(/\\/g, '/');
  if (DENY.some((re) => re.test(rel))) return null;
  const abs = join(APP_ROOT, rel.split('/').join(sep));
  const root = APP_ROOT.endsWith(sep) ? APP_ROOT : APP_ROOT + sep;
  if (!abs.startsWith(root) && abs !== APP_ROOT.replace(/[\\/]$/, '')) return null;
  return abs;
}

async function serveStatic(req, res, pathname) {
  let target = resolveStatic(pathname === '/' ? '/index.html' : pathname);
  if (!target) return send(res, 403, { error: 'forbidden' });
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) target = join(target, 'index.html');
    await fs.access(target);
  } catch {
    return send(res, 404, { error: 'not found' });
  }
  res.writeHead(200, {
    'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store'
  });
  createReadStream(target).pipe(res);
}

async function serveMedia(library, req, res, id) {
  const located = library.pathFor(id);
  if (!located) return send(res, 404, { error: 'unknown track' });
  let stat;
  try {
    stat = await fs.stat(located.abs);
  } catch {
    return send(res, 404, { error: 'file missing' });
  }

  const type = MIME[extname(located.abs).toLowerCase()] ?? 'application/octet-stream';
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (match) {
    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : stat.size - 1;
    if (!match[1] && match[2]) {
      start = Math.max(0, stat.size - Number(match[2]));
      end = stat.size - 1;
    }
    if (start >= stat.size || start > end) {
      return send(res, 416, { error: 'range not satisfiable' }, { 'content-range': `bytes */${stat.size}` });
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store'
    });
    return createReadStream(located.abs, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store'
  });
  createReadStream(located.abs).pipe(res);
}

async function handleApi(config, library, req, res, url) {
  const p = url.pathname;
  const num = (name, fallback) => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? v : fallback;
  };

  if (p === '/api/config') {
    if (req.method === 'GET') return send(res, 200, config.get());
    if (req.method === 'PUT') {
      const body = JSON.parse((await readBody(req, 8192)).toString('utf8') || '{}');
      try {
        return send(res, 200, config.update(body));
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  if (p === '/api/library/status') return send(res, 200, library.status);
  if (p === '/api/library/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive'
    });
    res.write(': connected\n\n');
    return library.subscribe(res);
  }

  if (p === '/api/library/dirs') {
    const parent = url.searchParams.get('parent');
    return send(res, 200, {
      items: library.tree(parent === null || parent === '' ? null : Number(parent))
    });
  }

  if (p === '/api/library/folder') {
    const data = library.folder(
      num('id', 0),
      num('offset', 0),
      Math.min(500, num('limit', 200)),
      url.searchParams.get('recursive') !== '0'
    );
    return data ? send(res, 200, data) : send(res, 404, { error: 'unknown folder' });
  }

  if (p === '/api/library/search') {
    return send(
      res,
      200,
      library.search(url.searchParams.get('q') ?? '', {
        dirPath: url.searchParams.get('dir') || null,
        offset: num('offset', 0),
        limit: Math.min(500, num('limit', 200))
      })
    );
  }

  if (p === '/api/library/tags' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
    const items = await library.readTagsFor(Array.isArray(body.ids) ? body.ids.map(Number) : []);
    return send(res, 200, { items });
  }

  if (p === '/api/library/rescan' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
    return send(res, 200, library.startScan(body.mode === 'full' ? 'full' : 'auto'));
  }

  const analysis = /^\/api\/library\/analysis\/(\d+)$/.exec(p);
  if (analysis) {
    const id = Number(analysis[1]);
    if (req.method === 'GET') {
      const cached = library.getAnalysis(id);
      if (!cached) {
        res.writeHead(204, { 'cache-control': 'no-store' });
        return res.end();
      }
      return send(res, 200, cached.peaks, {
        'content-type': 'application/octet-stream',
        'x-bpm': String(cached.bpm ?? ''),
        'x-beat-offset': String(cached.beatOffset ?? ''),
        'x-duration': String(cached.duration ?? ''),
        'x-bucket-size': String(cached.bucketSize ?? '')
      });
    }
    if (req.method === 'PUT') {
      const bytes = await readBody(req, 64 * 1024 * 1024);
      const ok = library.putAnalysis(
        id,
        {
          bpm: Number(url.searchParams.get('bpm')) || null,
          beatOffset: Number(url.searchParams.get('beatOffset')) || 0,
          duration: Number(url.searchParams.get('duration')) || null,
          bucketSize: Number(url.searchParams.get('bucketSize')) || null
        },
        bytes
      );
      return send(res, ok ? 200 : 404, { ok });
    }
  }

  if (p === '/api/library/import' && req.method === 'POST') {
    const bytes = await readBody(req);
    if (!bytes.byteLength) return send(res, 400, { error: 'empty body' });
    return send(
      res,
      200,
      await library.importFile({
        bytes,
        folder: url.searchParams.get('folder') ?? 'jamendo',
        fileName: url.searchParams.get('name') ?? `track-${Date.now()}.mp3`,
        artist: url.searchParams.get('artist'),
        title: url.searchParams.get('title'),
        source: url.searchParams.get('source'),
        sourceId: url.searchParams.get('sourceId'),
        license: url.searchParams.get('license'),
        pageUrl: url.searchParams.get('pageUrl')
      })
    );
  }

  /**
   * Downloads a track on the client's behalf. Jamendo's CDN sometimes answers with a
   * cached Access-Control-Allow-Origin belonging to a different client, which the
   * browser then rejects; the server has no such constraint.
   */
  if (p === '/api/library/import-url' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 8192)).toString('utf8') || '{}');
    let target;
    try {
      target = new URL(String(body.url));
    } catch {
      return send(res, 400, { error: 'invalid url' });
    }
    if (target.protocol !== 'https:' || !isAllowedImportHost(target.hostname)) {
      return send(res, 400, { error: 'only https jamendo.com downloads are allowed' });
    }

    const upstream = await fetch(target, { redirect: 'follow' });
    if (!upstream.ok) return send(res, 502, { error: `upstream returned ${upstream.status}` });
    if (!isAllowedImportHost(new URL(upstream.url).hostname)) {
      return send(res, 400, { error: 'download redirected off jamendo.com' });
    }
    if (Number(upstream.headers.get('content-length')) > MAX_IMPORT_BYTES) {
      return send(res, 413, { error: 'download too large' });
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (!bytes.byteLength) return send(res, 502, { error: 'upstream sent no data' });
    if (bytes.byteLength > MAX_IMPORT_BYTES) return send(res, 413, { error: 'download too large' });

    return send(
      res,
      200,
      await library.importFile({
        bytes,
        folder: body.folder ?? 'jamendo',
        fileName: body.name ?? `track-${Date.now()}.mp3`,
        artist: body.artist,
        title: body.title,
        source: body.source,
        sourceId: body.sourceId,
        license: body.license,
        pageUrl: body.pageUrl
      })
    );
  }

  return send(res, 404, { error: 'unknown endpoint' });
}

function licenseLabel(url) {
  const match = /creativecommons\.org\/licenses\/([a-z-]+)\//i.exec(url ?? '');
  return match ? `CC ${match[1].toUpperCase()}` : 'CC';
}

/** Tracks archived before provenance was stored have no licence; recover it once. */
async function backfillLicenses(config, library) {
  const clientId = config.get().jamendoClientId;
  if (!clientId) return;
  const pending = library.tracksMissingLicense(200);
  if (!pending.length) return;

  const params = new URLSearchParams({
    client_id: clientId,
    format: 'json',
    limit: '200',
    id: pending.map((p) => p.sourceId).join(' '),
    include: 'licenses',
    type: 'single albumtrack'
  });
  const res = await fetch(`https://api.jamendo.com/v3.0/tracks/?${params}`);
  if (!res.ok) throw new Error(`Jamendo returned ${res.status}`);
  const body = await res.json();
  const byId = new Map((body.results ?? []).map((r) => [String(r.id), r]));

  let filled = 0;
  for (const row of pending) {
    const track = byId.get(row.sourceId);
    if (!track) continue;
    library.setLicense(row.id, licenseLabel(track.license_ccurl), track.shareurl);
    filled++;
  }
  if (filled) console.log(`  licences recovered for ${filled} archived track(s)`);
}

/**
 * Boots the library, the settings store and the HTTP listener.
 * `onListening` fires after bind but before the first scan, so a caller can print
 * the pre-scan counts. Returns the live port, which matters when options.port is 0.
 */
export async function startServer(options, { onListening } = {}) {
  const config = new Config(options.configFile);
  const library = new Library(options);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(config, library, req, res, url);
      const media = /^\/media\/(\d+)$/.exec(url.pathname);
      if (media) return await serveMedia(library, req, res, Number(media[1]));
      return await serveStatic(req, res, url.pathname);
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: err?.message ?? 'server error' });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    const done = () => {
      server.off('error', reject);
      resolve();
    };
    if (options.host) server.listen(options.port, options.host, done);
    else server.listen(options.port, done);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    library.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  };

  onListening?.({ port, library, config });

  library.startScan();
  library.startWatching();
  backfillLicenses(config, library).catch((err) =>
    console.warn(`  licence backfill skipped: ${err.message}`)
  );

  return { server, port, library, config, close };
}
