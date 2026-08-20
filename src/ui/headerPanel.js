const MODES = [
  { value: 'headphones', label: 'Headphones · second device' },
  { value: 'split4', label: 'Split 4-channel · out 3/4' },
  { value: 'master', label: 'Master only' }
];

/** Cue routing and the output device pickers. Always lives in the console window. */
export function buildHeader(app) {
  const el = document.createElement('div');
  el.className = 'routing';
  el.innerHTML = `
    <label class="field">
      <span>Cue routing</span>
      <select class="js-mode">${MODES.map((m) => `<option value="${m.value}">${m.label}</option>`).join('')}</select>
    </label>
    <label class="field grow">
      <span>Master device</span>
      <select class="js-master"><option value="">System default</option></select>
    </label>
    <label class="field grow">
      <span>Headphone device</span>
      <select class="js-device"><option value="">System default</option></select>
    </label>
    <button class="ghost js-unlock" type="button" title="Grant permission so device names can be listed">Name devices</button>`;

  const modeSel = el.querySelector('.js-mode');
  const devSel = el.querySelector('.js-device');
  const masterSel = el.querySelector('.js-master');

  const reflectMode = (mode) => {
    modeSel.value = mode;
    devSel.disabled = mode !== 'headphones';
  };
  modeSel.addEventListener('change', () => app.params.set('out.mode', modeSel.value));
  app.params.subscribe('out.mode', reflectMode);
  reflectMode(app.params.get('out.mode', 'headphones'));

  // Both sinks landing on the same card is the usual reason "everything comes out of one device".
  function warnIfClashing() {
    if (app.params.get('out.mode', 'headphones') !== 'headphones') return;
    if (app.params.get('out.master', '') !== app.params.get('out.device', '')) return;
    app.toast('Master and headphone cue point at the same output — pick a different device for one of them.', 5000);
  }

  devSel.addEventListener('change', () => {
    app.params.set('out.device', devSel.value);
    warnIfClashing();
  });
  app.params.subscribe('out.device', (v) => {
    if (devSel.value !== v) devSel.value = v;
  });

  masterSel.addEventListener('change', () => {
    if (typeof app.engine.ctx?.setSinkId !== 'function') {
      app.toast('This browser cannot move the master bus to another device — use the desktop app or Chromium.', 5000);
      masterSel.value = app.params.get('out.master', '');
      return;
    }
    app.params.set('out.master', masterSel.value);
    warnIfClashing();
  });
  app.params.subscribe('out.master', (v) => {
    if (masterSel.value !== v) masterSel.value = v;
  });

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default');

    for (const [sel, paramId] of [
      [masterSel, 'out.master'],
      [devSel, 'out.device']
    ]) {
      const wanted = app.params.get(paramId, '');
      sel.innerHTML = '<option value="">System default</option>';
      outputs.forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Output ${i + 1}`;
        sel.appendChild(o);
      });
      sel.value = wanted;
    }
  }

  el.querySelector('.js-unlock').addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      await refreshDevices();
      app.toast('Output device names unlocked.');
    } catch {
      app.toast('Permission denied — device names stay hidden, IDs still work.');
    }
  });

  navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
  refreshDevices();

  return el;
}
