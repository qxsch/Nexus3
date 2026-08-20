const MAGIC = 0x4e583341; // "NX3A"
const HEADER = 28;
const VERSION = 1;

/** Packs a worker analysis result into a compact blob for the server-side cache. */
export function encodeAnalysis(a) {
  const count = a.min.length;
  const buf = new ArrayBuffer(HEADER + count * 7);
  const view = new DataView(buf);
  view.setUint32(0, MAGIC, true);
  view.setUint8(4, VERSION);
  view.setUint32(8, a.bucketSize, true);
  view.setUint32(12, count, true);
  view.setFloat32(16, a.bpm ?? 0, true);
  view.setFloat32(20, a.beatOffset ?? 0, true);
  view.setFloat32(24, a.duration ?? 0, true);

  const min = new Int16Array(buf, HEADER, count);
  const max = new Int16Array(buf, HEADER + count * 2, count);
  const bands = new Uint8Array(buf, HEADER + count * 4, count * 3);
  for (let i = 0; i < count; i++) {
    min[i] = Math.max(-32767, Math.min(32767, Math.round(a.min[i] * 32767)));
    max[i] = Math.max(-32767, Math.min(32767, Math.round(a.max[i] * 32767)));
    bands[i] = a.low[i];
    bands[count + i] = a.mid[i];
    bands[count * 2 + i] = a.high[i];
  }
  return new Uint8Array(buf);
}

export function decodeAnalysis(bytes) {
  if (!bytes || bytes.byteLength < HEADER) return null;
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const view = new DataView(buf);
  if (view.getUint32(0, true) !== MAGIC || view.getUint8(4) !== VERSION) return null;

  const bucketSize = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  if (buf.byteLength < HEADER + count * 7) return null;

  const rawMin = new Int16Array(buf, HEADER, count);
  const rawMax = new Int16Array(buf, HEADER + count * 2, count);
  const bands = new Uint8Array(buf, HEADER + count * 4, count * 3);

  const min = new Float32Array(count);
  const max = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    min[i] = rawMin[i] / 32767;
    max[i] = rawMax[i] / 32767;
  }
  return {
    bpm: view.getFloat32(16, true),
    beatOffset: view.getFloat32(20, true),
    duration: view.getFloat32(24, true),
    bucketSize,
    min,
    max,
    low: bands.slice(0, count),
    mid: bands.slice(count, count * 2),
    high: bands.slice(count * 2, count * 3)
  };
}
