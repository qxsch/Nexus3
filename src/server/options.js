import { existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.m4a',
  '.aac',
  '.aiff',
  '.aif',
  '.webm'
]);

const USAGE = `
NEXUS-3 DJ console

  node server.js [options]

  --music <dir>           Music library root            (default ./downloaded-mp3)
  --db <file>             SQLite index file             (default .cache/library-<hash>.db)
  --config <file>         Settings file                 (default ./config.json)
  --scan auto|full|off    Index mode at startup         (default auto)
  --watch                 Watch the library for changes (default off)
  --scan-concurrency <n>  Parallel directory reads      (default 8)
  --analysis-cap <n>      Cached track analyses         (default 1000)
  --port <n>              HTTP port                     (default 5173)
  --host <addr>           Bind address                  (default all interfaces)
  --help                  Show this message

Environment fallbacks: MUSIC_DIR, MUSIC_DB, NEXUS_CONFIG, JAMENDO_CLIENT_ID, PORT, HOST
`;

function readFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) return true;
  return value;
}

/**
 * `defaults` lets an embedder (the Electron shell) relocate the writable paths and the
 * listener without touching the CLI contract: explicit flags and env vars still win.
 */
export function parseOptions(argv = process.argv.slice(2), defaults = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  // Writable state (index, settings) lives here; APP_ROOT holds the read-only assets.
  const dataRoot = defaults.dataRoot ?? APP_ROOT;
  const resolveIn = (value) => (isAbsolute(value) ? resolve(value) : resolve(dataRoot, value));

  const musicArg = readFlag(argv, '--music') ?? process.env.MUSIC_DIR ?? defaults.musicRoot ?? './downloaded-mp3';
  const musicRoot = resolveIn(musicArg);

  const scan = String(readFlag(argv, '--scan') ?? defaults.scan ?? 'auto');
  if (!['auto', 'full', 'off'].includes(scan)) {
    throw new Error(`--scan must be auto, full or off (got "${scan}")`);
  }

  const dbArg = readFlag(argv, '--db') ?? process.env.MUSIC_DB ?? defaults.dbFile;
  const dbFile = dbArg
    ? resolveIn(String(dbArg))
    : join(dataRoot, '.cache', `library-${createHash('sha1').update(musicRoot.toLowerCase()).digest('hex').slice(0, 12)}.db`);

  const configArg = readFlag(argv, '--config') ?? process.env.NEXUS_CONFIG ?? defaults.configFile ?? './config.json';
  const configFile = resolveIn(String(configArg));

  const hostArg = readFlag(argv, '--host') ?? process.env.HOST ?? defaults.host;

  return {
    musicRoot,
    dataRoot,
    dbFile,
    configFile,
    scan,
    watch: argv.includes('--watch') || defaults.watch === true,
    scanConcurrency: Math.max(1, Math.min(64, Number(readFlag(argv, '--scan-concurrency')) || 8)),
    analysisCap: Math.max(0, Number(readFlag(argv, '--analysis-cap')) || 1000),
    port: Number(readFlag(argv, '--port')) || Number(process.env.PORT) || (defaults.port ?? 5173),
    host: typeof hostArg === 'string' && hostArg ? hostArg : undefined,
    audioExtensions: AUDIO_EXTENSIONS
  };
}

export function ensureDirs(options) {
  for (const dir of [options.musicRoot, resolve(options.dbFile, '..')]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function isAudioFile(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && AUDIO_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

export { AUDIO_EXTENSIONS };
