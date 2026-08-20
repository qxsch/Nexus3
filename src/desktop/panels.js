/**
 * The set of boxes that can live in their own window. The transport and routing row is
 * deliberately absent: it stays in the console window, which carries the menu bar.
 * `minWidth`/`minHeight` are floors the window can never go below; a freshly detached
 * window opens at whatever its content actually measures, clamped to these.
 */
export const PANELS = [
  { id: 'deckA', title: 'Deck A', deck: 0, minWidth: 430, minHeight: 620 },
  { id: 'deckB', title: 'Deck B', deck: 1, minWidth: 430, minHeight: 620 },
  { id: 'deckC', title: 'Deck C', deck: 2, minWidth: 430, minHeight: 620 },
  { id: 'crate', title: 'Crate', minWidth: 700, minHeight: 420 },
  { id: 'fx', title: 'FX rack', minWidth: 320, minHeight: 540 },
  { id: 'channels', title: 'Channels', minWidth: 580, minHeight: 640 },
  { id: 'master', title: 'Master', minWidth: 300, minHeight: 410 }
];

export const PANEL_IDS = PANELS.map((p) => p.id);
export const panelById = (id) => PANELS.find((p) => p.id === id) ?? null;
