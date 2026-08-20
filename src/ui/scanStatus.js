import { library } from '../services/library.js';

const fmtInt = new Intl.NumberFormat();

function fmtElapsed(ms) {
  if (!ms) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Small always-visible scan indicator plus a details modal. Never blocks the UI. */
export class ScanStatus {
  constructor(host, onChange) {
    this.onChange = onChange ?? (() => {});
    this.status = null;

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'scan-dot';
    this.button.title = 'Library index status';
    this.button.innerHTML = `
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle class="scan-ring-bg" cx="18" cy="18" r="15"></circle>
        <circle class="scan-ring" cx="18" cy="18" r="15"></circle>
      </svg>
      <span class="scan-dot-core"></span>`;
    host.appendChild(this.button);

    this.modal = document.createElement('div');
    this.modal.className = 'modal hidden';
    this.modal.innerHTML = `
      <div class="modal-card">
        <h2>Library index</h2>
        <dl class="scan-facts">
          <dt>Folder</dt><dd class="js-root">-</dd>
          <dt>State</dt><dd class="js-state">-</dd>
          <dt>Indexed</dt><dd class="js-indexed">-</dd>
          <dt>This scan</dt><dd class="js-scan">-</dd>
          <dt>Changes</dt><dd class="js-changes">-</dd>
          <dt>Current</dt><dd class="js-current">-</dd>
        </dl>
        <p class="scan-note">Scanning runs on a worker thread. You can keep browsing, searching and
          mixing while it works.</p>
        <div class="scan-actions">
          <button class="ghost js-quick" type="button">Quick rescan</button>
          <button class="ghost js-full" type="button">Full re-index</button>
          <button class="ghost js-close" type="button">Close</button>
        </div>
      </div>`;
    document.body.appendChild(this.modal);

    this.button.addEventListener('click', () => this.modal.classList.toggle('hidden'));
    this.modal.querySelector('.js-close').addEventListener('click', () => this.modal.classList.add('hidden'));
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.modal.classList.add('hidden');
    });
    this.modal.querySelector('.js-quick').addEventListener('click', () => library.rescan('auto').catch(() => {}));
    this.modal.querySelector('.js-full').addEventListener('click', () => library.rescan('full').catch(() => {}));

    library.status().then((s) => this.apply(s)).catch(() => {});
    this.dispose = library.subscribe((s) => this.apply(s));
  }

  apply(status) {
    const previous = this.status;
    const wasScanning = previous?.state === 'scanning';
    this.status = status;
    const scanning = status.state === 'scanning';

    this.button.classList.toggle('scanning', scanning);
    this.button.classList.toggle('failed', status.state === 'error');
    this.button.title = scanning
      ? `Indexing: ${fmtInt.format(status.scannedFiles)} files`
      : status.state === 'error'
        ? `Index error: ${status.error}`
        : `${fmtInt.format(status.tracks)} tracks indexed`;

    const q = (s) => this.modal.querySelector(s);
    q('.js-root').textContent = status.root;
    q('.js-state').textContent =
      status.state === 'error' ? `error: ${status.error}` : scanning ? 'scanning' : 'idle';
    q('.js-indexed').textContent = `${fmtInt.format(status.tracks)} tracks in ${fmtInt.format(status.dirs)} folders`;
    q('.js-scan').textContent = `${fmtInt.format(status.scannedFiles)} files, ${fmtInt.format(
      status.scannedDirs
    )} folders in ${fmtElapsed(status.elapsedMs)}`;
    q('.js-changes').textContent = `+${fmtInt.format(status.added)} added, ${fmtInt.format(
      status.updated
    )} updated, ${fmtInt.format(status.removed)} removed`;
    q('.js-current').textContent = status.currentPath || '-';

    const countChanged = previous && previous.tracks !== status.tracks;
    if ((wasScanning && !scanning) || countChanged) this.onChange(status);
  }
}
