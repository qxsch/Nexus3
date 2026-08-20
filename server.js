import { parseOptions, ensureDirs } from './src/server/options.js';
import { startServer } from './src/server/app.js';

const options = parseOptions();
ensureDirs(options);

const app = await startServer(options, {
  onListening: ({ port, library }) => {
    console.log(`
  NEXUS-3  ->  http://${options.host ?? 'localhost'}:${port}

  library   ${options.musicRoot}
  index     ${options.dbFile}
  config    ${options.configFile}
  indexed   ${library.status.tracks} tracks in ${library.status.dirs} folders
  scan      ${options.scan}${options.watch ? ' + watch' : ''}
`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    app.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

