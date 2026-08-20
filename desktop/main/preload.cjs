const { contextBridge, ipcRenderer } = require('electron');

// Marked before the page paints so the stylesheet can drop the boot overlay outright;
// the desktop app starts its audio engine without waiting for a click. The value is the
// document state at the time, so a regression in that timing is visible in the DOM.
const markDesktop = () => {
  if (!document.documentElement) return false;
  document.documentElement.setAttribute('data-desktop', document.readyState);
  return true;
};

// The preload runs before the parser has created <html>, so wait for it.
if (!markDesktop()) {
  const observer = new MutationObserver(() => {
    if (markDesktop()) observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
}

// Identity plus the layout channel; the UI talks to the local server for everything else.
contextBridge.exposeInMainWorld('nexus', {
  desktop: true,
  platform: process.platform,
  info: () => ipcRenderer.invoke('nexus:info'),
  pickMusicFolder: () => ipcRenderer.invoke('nexus:pick-music-folder'),
  rescan: (mode) => ipcRenderer.invoke('nexus:rescan', mode),
  fitWindow: (size) => ipcRenderer.send('nexus:fit-window', size),
  onLayout: (fn) => {
    ipcRenderer.on('nexus:layout', (_event, data) => fn(data));
  }
});
