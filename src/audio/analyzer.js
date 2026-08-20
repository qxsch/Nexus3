let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/analyzer.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id } = e.data;
    const resolve = pending.get(id);
    if (resolve) {
      pending.delete(id);
      resolve(e.data);
    }
  };
  return worker;
}

/** Downmixes to mono and runs peak/BPM analysis off the main thread. */
export function analyzeBuffer(audioBuffer) {
  const len = audioBuffer.length;
  const mono = new Float32Array(len);
  const chCount = audioBuffer.numberOfChannels;
  for (let c = 0; c < chCount; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i];
  }
  if (chCount > 1) for (let i = 0; i < len; i++) mono[i] /= chCount;

  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ id, mono, sampleRate: audioBuffer.sampleRate }, [mono.buffer]);
  });
}
