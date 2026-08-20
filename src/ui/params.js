/**
 * Every persistent mixer value lives here rather than in a DOM control, so a panel
 * keeps its settings when it moves between windows, and so a control in one window
 * follows a change made in another.
 */
export class Params {
  constructor(values = {}) {
    this.values = { ...values };
    this.subscribers = new Map();
    this.onChange = null;
  }

  get(id, fallback) {
    const v = this.values[id];
    return v === undefined ? fallback : v;
  }

  /** `silent` replays a remote change without echoing it back out. */
  set(id, value, silent = false) {
    if (this.values[id] === value) return;
    this.values[id] = value;
    for (const fn of this.subscribers.get(id) ?? []) fn(value);
    if (!silent) this.onChange?.(id, value);
  }

  subscribe(id, fn) {
    if (!this.subscribers.has(id)) this.subscribers.set(id, new Set());
    this.subscribers.get(id).add(fn);
    return () => this.subscribers.get(id)?.delete(fn);
  }

  merge(values, silent = true) {
    for (const [id, value] of Object.entries(values ?? {})) this.set(id, value, silent);
  }

  snapshot() {
    return { ...this.values };
  }
}
