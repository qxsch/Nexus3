import { library } from '../services/library.js';
import { jamendo } from '../services/jamendo.js';

const ROW_H = 34;
const PAGE = 200;
const JAMENDO_PAGE = 40;
const JAMENDO_EMPTY_LIMIT = 3;
const OVERSCAN = 8;

const fmtInt = new Intl.NumberFormat();

function fmtDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Library browser and Jamendo search, both feeding the same load-to-deck action. */
export class CratePanel {
  constructor(root, app) {
    this.app = app;
    this.tab = 'library';
    this.scope = null;
    this.query = '';
    this.pages = new Map();
    this.inflight = new Set();
    this.total = 0;
    this.searchTimer = 0;
    this.searchAbort = null;
    this.jamendoItems = [];
    this.jamendoOffset = 0;
    this.jamendoDone = false;
    this.expanded = new Set(JSON.parse(localStorage.getItem('nx3.crate.expanded') ?? '[]'));

    root.innerHTML = `
      <div class="crate-bar">
        <button class="crate-toggle js-toggle" type="button" aria-expanded="true">CRATE</button>
        <div class="seg crate-tabs js-tabs">
          <button type="button" class="on" data-tab="library">Library</button>
          <button type="button" data-tab="jamendo">Jamendo</button>
        </div>
        <input class="crate-search js-search" type="search" placeholder="search file names" spellcheck="false" />
        <span class="crate-scope js-scope hidden"></span>
        <span class="crate-count js-count"></span>
        <button class="ghost js-key hidden" type="button" title="Jamendo client ID">Client ID</button>
        <button class="ghost js-rescan" type="button" title="Re-index the library folder">Rescan</button>
      </div>
      <div class="crate-body js-body">
        <aside class="crate-tree js-tree"></aside>
        <div class="crate-main">
          <div class="crate-scroll js-scroll">
            <div class="crate-spacer js-spacer"></div>
            <div class="crate-rows js-rows"></div>
          </div>
          <div class="crate-empty js-empty hidden"></div>
        </div>
      </div>
      <div class="jamendo-setup js-setup hidden">
        <p>Jamendo needs a free client ID from <a href="https://devportal.jamendo.com/" target="_blank" rel="noreferrer">devportal.jamendo.com</a>. It is stored in <span class="js-store"></span>.</p>
        <div class="setup-row">
          <input class="js-client-id" type="text" placeholder="client_id" spellcheck="false" autocomplete="off" />
          <button class="js-save-id" type="button">Save</button>
          <span class="setup-status js-setup-status"></span>
        </div>
      </div>`;

    this.el = root;
    this.$ = (s) => root.querySelector(s);
    this.scroll = this.$('.js-scroll');
    this.rows = this.$('.js-rows');
    this.spacer = this.$('.js-spacer');
    this.treeEl = this.$('.js-tree');
    this.countEl = this.$('.js-count');
    this.emptyEl = this.$('.js-empty');
    this.scopeEl = this.$('.js-scope');
    this.searchEl = this.$('.js-search');
    this.setupEl = this.$('.js-setup');

    this.#bind();
    this.refreshTree();
    this.reload();
  }

  #bind() {
    this.$('.js-toggle').addEventListener('click', () => {
      const open = this.el.classList.toggle('collapsed');
      this.$('.js-toggle').setAttribute('aria-expanded', String(!open));
    });

    this.$('.js-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      for (const b of this.$('.js-tabs').querySelectorAll('button')) b.classList.toggle('on', b === btn);
      this.tab = btn.dataset.tab;
      this.el.classList.toggle('jamendo-mode', this.tab === 'jamendo');
      this.searchEl.placeholder =
        this.tab === 'jamendo' ? 'search the Jamendo catalogue' : 'search file names';
      this.$('.js-key').classList.toggle('hidden', this.tab !== 'jamendo');
      this.keyPanelOpen = this.tab === 'jamendo' && !jamendo.configured;
      this.#syncSetup();
      this.reload();
    });

    this.searchEl.addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.query = this.searchEl.value.trim();
        this.reload();
      }, this.tab === 'jamendo' ? 350 : 160);
    });
    this.searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.searchEl.value = '';
        this.query = '';
        this.reload();
      }
    });

    this.$('.js-rescan').addEventListener('click', () => {
      library.rescan('auto').catch(() => {});
    });

    this.scopeEl.addEventListener('click', () => {
      this.scope = null;
      this.scopeEl.classList.add('hidden');
      this.treeEl.querySelectorAll('.tree-node.on').forEach((n) => n.classList.remove('on'));
      this.reload();
    });

    this.scroll.addEventListener('scroll', () => this.render(), { passive: true });

    this.rows.addEventListener('click', (e) => {
      const deckBtn = e.target.closest('button[data-deck]');
      if (!deckBtn) return;
      const row = deckBtn.closest('.crate-row');
      this.#loadRow(Number(row.dataset.index), Number(deckBtn.dataset.deck));
    });

    this.rows.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.crate-row');
      if (row) this.#loadRow(Number(row.dataset.index), 0);
    });

    this.rows.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.crate-row');
      if (!row) return;
      const source = this.#sourceAt(Number(row.dataset.index));
      if (!source) return;
      e.dataTransfer.setData('application/x-nx3-source', JSON.stringify(source));
      e.dataTransfer.effectAllowed = 'copy';
    });

    this.treeEl.addEventListener('click', (e) => {
      const twisty = e.target.closest('.tree-twisty');
      const node = e.target.closest('.tree-node');
      if (!node) return;
      const id = Number(node.dataset.id);
      if (twisty) {
        if (this.expanded.has(id)) this.expanded.delete(id);
        else this.expanded.add(id);
        localStorage.setItem('nx3.crate.expanded', JSON.stringify([...this.expanded]));
        this.refreshTree();
        return;
      }
      this.scope = { id, path: node.dataset.path, name: node.dataset.name };
      this.treeEl.querySelectorAll('.tree-node.on').forEach((n) => n.classList.remove('on'));
      node.classList.add('on');
      if (this.scope.path) {
        this.scopeEl.textContent = `${this.scope.path} \u00d7`;
        this.scopeEl.classList.remove('hidden');
      } else {
        this.scopeEl.classList.add('hidden');
      }
      this.reload();
    });

    this.$('.js-save-id').addEventListener('click', () => this.#saveClientId());
    this.$('.js-client-id').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.#saveClientId();
    });
    this.$('.js-key').addEventListener('click', () => {
      this.keyPanelOpen = !this.keyPanelOpen;
      this.#syncSetup();
    });
    this.$('.js-client-id').value = jamendo.clientId;
    this.$('.js-store').textContent = jamendo.storageLabel;
  }

  #syncSetup() {
    const show = this.tab === 'jamendo' && (this.keyPanelOpen || !jamendo.configured);
    this.setupEl.classList.toggle('hidden', !show);
    this.$('.js-key').classList.toggle('on', show);
    if (show) this.$('.js-client-id').value = jamendo.clientId;
  }

  async #saveClientId() {
    const button = this.$('.js-save-id');
    const status = this.$('.js-setup-status');
    button.disabled = true;
    status.className = 'setup-status js-setup-status';
    status.textContent = 'saving...';
    try {
      await jamendo.setClientId(this.$('.js-client-id').value);
      status.classList.add('ok');
      status.textContent = jamendo.configured ? 'saved' : 'cleared';
      this.keyPanelOpen = !jamendo.configured;
      this.#syncSetup();
      this.reload();
    } catch (err) {
      status.classList.add('bad');
      status.textContent = err.message;
    } finally {
      button.disabled = false;
      setTimeout(() => {
        status.textContent = '';
        status.className = 'setup-status js-setup-status';
      }, 2600);
    }
  }

  // -------------------------------------------------------------- folder tree

  async refreshTree() {
    const build = async (parentId, depth) => {
      let nodes;
      try {
        nodes = await library.dirs(parentId);
      } catch {
        return [];
      }
      const out = [];
      for (const dir of nodes) {
        out.push({ ...dir, depth });
        if (this.expanded.has(dir.id)) out.push(...(await build(dir.id, depth + 1)));
      }
      return out;
    };

    const roots = await library.dirs(null).catch(() => []);
    if (roots.length && !this.expanded.size) this.expanded.add(roots[0].id);

    const flat = await build(null, 0);
    this.treeEl.innerHTML = flat
      .map((d) => {
        const open = this.expanded.has(d.id);
        const selected = this.scope?.id === d.id ? ' on' : '';
        const label = d.depth === 0 ? 'All tracks' : d.name;
        return `<div class="tree-node${selected}" data-id="${d.id}" data-path="${escapeAttr(d.path)}"
                     data-name="${escapeAttr(label)}" style="--indent:${d.depth}">
                  <span class="tree-twisty">${open ? '\u25be' : '\u25b8'}</span>
                  <span class="tree-name">${escapeHtml(label)}</span>
                  <span class="tree-count">${fmtInt.format(d.total)}</span>
                </div>`;
      })
      .join('');
  }

  // ------------------------------------------------------------ data loading

  reload() {
    this.pages.clear();
    this.inflight.clear();
    this.total = 0;
    this.scroll.scrollTop = 0;
    if (this.tab === 'jamendo') {
      clearTimeout(this.jamendoTimer);
      this.jamendoItems = [];
      this.jamendoOffset = 0;
      this.jamendoDone = false;
      this.jamendoRetryAt = 0;
      this.jamendoEmpty = 0;
      this.#loadJamendo();
    } else {
      this.#ensurePage(0).then(() => this.render());
    }
    this.render();
  }

  async #ensurePage(pageIndex) {
    if (this.pages.has(pageIndex) || this.inflight.has(pageIndex)) return;
    this.inflight.add(pageIndex);
    const offset = pageIndex * PAGE;
    try {
      let items;
      if (this.query) {
        this.searchAbort?.abort();
        const controller = new AbortController();
        this.searchAbort = controller;
        const res = await library.search(this.query, {
          dir: this.scope?.path ?? null,
          offset,
          limit: PAGE,
          signal: controller.signal
        });
        items = res.items;
        this.total =
          res.approxTotal != null
            ? res.approxTotal
            : Math.max(this.total, offset + items.length + (items.length === PAGE ? PAGE : 0));
      } else {
        const dirId = this.scope?.id ?? (await this.#rootId());
        const res = await library.folder(dirId, offset, PAGE);
        items = res.items;
        this.total = res.total ?? items.length;
      }
      this.pages.set(pageIndex, items);
    } catch (err) {
      if (err.name !== 'AbortError') this.pages.set(pageIndex, []);
    } finally {
      this.inflight.delete(pageIndex);
    }
    this.render();
  }

  async #rootId() {
    if (this.rootDirId != null) return this.rootDirId;
    const dirs = await library.dirs(null);
    this.rootDirId = dirs[0]?.id ?? 1;
    return this.rootDirId;
  }

  async #loadJamendo() {
    if (!jamendo.configured) {
      this.jamendoDone = true;
      this.keyPanelOpen = true;
      this.#syncSetup();
      this.render();
      return;
    }
    if (this.jamendoDone || this.jamendoBusy) return;
    if (this.jamendoRetryAt && Date.now() < this.jamendoRetryAt) return;

    this.jamendoBusy = true;
    this.el.classList.add('busy');
    try {
      this.jamendoAbort?.abort();
      const controller = new AbortController();
      this.jamendoAbort = controller;
      const res = await jamendo.search(
        this.query,
        { offset: this.jamendoOffset, limit: JAMENDO_PAGE },
        controller.signal
      );
      this.jamendoItems.push(...res.items);
      this.jamendoOffset += res.items.length;
      // Jamendo intermittently answers an identical query with an empty result set
      // and no error, so an empty page is a retryable miss, not the end of the list.
      if (res.items.length === 0) {
        this.jamendoEmpty++;
        if (this.jamendoEmpty >= JAMENDO_EMPTY_LIMIT) this.jamendoDone = true;
        else this.#scheduleJamendoRetry();
      } else {
        this.jamendoEmpty = 0;
      }
      this.jamendoRetryAt = 0;
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn(`Jamendo page at offset ${this.jamendoOffset} failed`, err);
        this.jamendoRetryAt = Date.now() + 4000;
        this.app.toast(`Jamendo: ${err.message}`);
      }
    } finally {
      this.jamendoBusy = false;
      this.el.classList.remove('busy');
      this.render();
    }
  }

  #scheduleJamendoRetry(delay = 600) {
    clearTimeout(this.jamendoTimer);
    this.jamendoTimer = setTimeout(() => {
      if (this.tab === 'jamendo' && !this.jamendoDone) this.#loadJamendo();
    }, delay);
  }

  itemAt(index) {
    if (this.tab === 'jamendo') return this.jamendoItems[index] ?? null;
    const page = this.pages.get(Math.floor(index / PAGE));
    return page ? (page[index % PAGE] ?? null) : null;
  }

  #sourceAt(index) {
    const item = this.itemAt(index);
    if (!item) return null;
    return this.tab === 'jamendo'
      ? { kind: 'jamendo', track: item }
      : { kind: 'library', track: item };
  }

  #loadRow(index, deckIndex) {
    const source = this.#sourceAt(index);
    if (source) this.app.loadSourceToDeck(this.app.decks[deckIndex], source);
  }

  // ------------------------------------------------------------- virtual list

  render() {
    if (this.rendering) return;
    this.rendering = true;
    try {
      this.#draw();
    } finally {
      this.rendering = false;
    }
  }

  #draw() {
    const count = this.tab === 'jamendo' ? this.jamendoItems.length : this.total;
    this.spacer.style.height = `${Math.max(count, 0) * ROW_H}px`;

    const viewTop = this.scroll.scrollTop;
    const viewH = this.scroll.clientHeight || 320;
    const first = Math.max(0, Math.floor(viewTop / ROW_H) - OVERSCAN);
    const last = Math.min(count, Math.ceil((viewTop + viewH) / ROW_H) + OVERSCAN);

    if (this.tab === 'library') {
      for (let p = Math.floor(first / PAGE); p <= Math.floor(Math.max(0, last - 1) / PAGE); p++) {
        this.#ensurePage(p);
      }
    } else if (
      !this.jamendoDone &&
      !this.jamendoBusy &&
      jamendo.configured &&
      last >= this.jamendoItems.length - 4
    ) {
      this.#loadJamendo();
    }

    const html = [];
    const untagged = [];
    for (let i = first; i < last; i++) {
      const item = this.itemAt(i);
      const y = i * ROW_H;
      if (!item) {
        html.push(`<div class="crate-row skeleton" style="top:${y}px"></div>`);
        continue;
      }
      html.push(this.tab === 'jamendo' ? this.#jamendoRow(item, i, y) : this.#libraryRow(item, i, y));
      if (this.tab === 'library' && !item.tagged) untagged.push(item.id);
    }
    this.rows.innerHTML = html.join('');

    const label =
      this.tab === 'jamendo'
        ? `${fmtInt.format(this.jamendoItems.length)} results`
        : `${fmtInt.format(count)} tracks`;
    this.countEl.textContent = label;

    const empty = count === 0;
    this.emptyEl.classList.toggle('hidden', !empty);
    if (empty) {
      this.emptyEl.textContent =
        this.tab === 'jamendo'
          ? jamendo.configured
            ? 'No results. Try another search.'
            : 'Add a Jamendo client ID to search the catalogue.'
          : this.query
            ? 'Nothing matches that.'
            : 'No audio files indexed yet. Drop files into the library folder and hit Rescan.';
    }

    if (untagged.length) this.#hydrateTags(untagged);
  }

  async #hydrateTags(ids) {
    const key = ids.join(',');
    if (this.tagKey === key) return;
    this.tagKey = key;
    try {
      const updated = await library.tags(ids);
      const byId = new Map(updated.map((t) => [t.id, t]));
      for (const page of this.pages.values()) {
        for (let i = 0; i < page.length; i++) {
          const fresh = byId.get(page[i].id);
          if (fresh) page[i] = fresh;
        }
      }
      this.render();
    } catch {}
  }

  #libraryRow(item, index, y) {
    const title = item.title || item.name.replace(/\.[^.]+$/, '');
    const credit = creditLink(item.source, item.license, item.pageUrl);
    // The folder is dropped for provider-backed tracks, it just repeats the credit.
    const lead = [item.artist, credit ? null : item.folder || '/'].filter(Boolean).join(SEP);
    return `<div class="crate-row" draggable="true" data-index="${index}" style="top:${y}px">
      <span class="row-ext">${escapeHtml(item.ext.replace('.', ''))}</span>
      <span class="row-title">${escapeHtml(title)}</span>
      <span class="row-sub">${joinCredit(lead, credit)}</span>
      <span class="row-meta">${item.durationMs ? fmtDuration(item.durationMs / 1000) : fmtSize(item.size)}</span>
      ${deckButtons(index)}
    </div>`;
  }

  #jamendoRow(item, index, y) {
    const credit = creditLink('jamendo', item.license, item.pageUrl);
    return `<div class="crate-row" draggable="true" data-index="${index}" style="top:${y}px">
      <span class="row-art">${item.artworkUrl ? `<img src="${escapeAttr(item.artworkUrl)}" alt="" loading="lazy">` : ''}</span>
      <span class="row-title">${escapeHtml(item.title)}</span>
      <span class="row-sub">${joinCredit(item.artist, credit)}</span>
      <span class="row-meta">${fmtDuration(item.durationSec)}</span>
      ${deckButtons(index)}
    </div>`;
  }
}

const PROVIDERS = { jamendo: 'Jamendo' };
const SEP = ' \u00b7 ';

function joinCredit(lead, creditHtml) {
  const text = escapeHtml(lead ?? '');
  if (!creditHtml) return text;
  return text ? `${text}${SEP}${creditHtml}` : creditHtml;
}

/** Provider credit and per-track backlink, required by the Jamendo API terms. */
function creditLink(source, license, pageUrl) {
  const provider = PROVIDERS[source];
  if (!provider) return '';
  const label = [provider, license].filter(Boolean).join(SEP);
  const href = safeUrl(pageUrl);
  if (!href) return `<span class="row-link">${escapeHtml(label)}</span>`;
  return `<a class="row-link" href="${escapeAttr(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function safeUrl(value) {
  return /^https?:\/\//i.test(String(value ?? '')) ? value : '';
}

function deckButtons(index) {
  return `<span class="row-decks">
    <button type="button" data-deck="0" data-index="${index}">A</button>
    <button type="button" data-deck="1" data-index="${index}">B</button>
    <button type="button" data-deck="2" data-index="${index}">C</button>
  </span>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

const escapeAttr = escapeHtml;
