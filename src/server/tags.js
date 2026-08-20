import { open } from 'node:fs/promises';

const HEAD_BYTES = 96 * 1024;

const ID3_TEXT_FRAMES = {
  TIT2: 'title',
  TPE1: 'artist',
  TALB: 'album',
  TYER: 'year',
  TDRC: 'year',
  TLEN: 'lengthMs',
  TT2: 'title',
  TP1: 'artist',
  TAL: 'album',
  TYE: 'year'
};

function decodeText(buf, encoding) {
  try {
    if (encoding === 0) return new TextDecoder('latin1').decode(buf).replace(/\0+$/, '');
    if (encoding === 3) return new TextDecoder('utf-8').decode(buf).replace(/\0+$/, '');
    if (encoding === 1) {
      const le = buf[0] === 0xff && buf[1] === 0xfe;
      const be = buf[0] === 0xfe && buf[1] === 0xff;
      const body = le || be ? buf.subarray(2) : buf;
      return new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode(body).replace(/\0+$/, '');
    }
    return new TextDecoder('utf-16be').decode(buf).replace(/\0+$/, '');
  } catch {
    return '';
  }
}

function syncSafe(buf, offset) {
  return (
    ((buf[offset] & 0x7f) << 21) |
    ((buf[offset + 1] & 0x7f) << 14) |
    ((buf[offset + 2] & 0x7f) << 7) |
    (buf[offset + 3] & 0x7f)
  );
}

function parseId3v2(buf) {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null;
  const major = buf[3];
  const flags = buf[5];
  const tagSize = syncSafe(buf, 6);
  let pos = 10;
  if (flags & 0x40) pos += major >= 4 ? syncSafe(buf, pos) : buf.readUInt32BE(pos) + 4;
  const end = Math.min(buf.length, 10 + tagSize);
  const idLen = major === 2 ? 3 : 4;
  const headerLen = major === 2 ? 6 : 10;
  const out = {};

  while (pos + headerLen <= end) {
    const id = new TextDecoder('latin1').decode(buf.subarray(pos, pos + idLen));
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    let size;
    if (major === 2) size = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5];
    else if (major >= 4) size = syncSafe(buf, pos + 4);
    else size = buf.readUInt32BE(pos + 4);
    if (size <= 0 || pos + headerLen + size > end) break;

    const field = ID3_TEXT_FRAMES[id];
    if (field) {
      const body = buf.subarray(pos + headerLen, pos + headerLen + size);
      const value = decodeText(body.subarray(1), body[0]).trim();
      if (value && !out[field]) out[field] = value;
    }
    pos += headerLen + size;
  }
  return Object.keys(out).length ? out : null;
}

function parseId3v1(buf) {
  if (buf.length < 128) return null;
  const tail = buf.subarray(buf.length - 128);
  if (tail[0] !== 0x54 || tail[1] !== 0x41 || tail[2] !== 0x47) return null;
  const str = (a, b) => new TextDecoder('latin1').decode(tail.subarray(a, b)).replace(/\0.*$/, '').trim();
  const out = {
    title: str(3, 33),
    artist: str(33, 63),
    album: str(63, 93),
    year: str(93, 97)
  };
  return out.title || out.artist ? out : null;
}

function parseFlac(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x664c6143) return null;
  let pos = 4;
  const out = {};
  while (pos + 4 <= buf.length) {
    const header = buf[pos];
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const size = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    const start = pos + 4;
    if (start + size > buf.length) break;

    if (type === 0 && size >= 18) {
      const rate = (buf[start + 10] << 12) | (buf[start + 11] << 4) | (buf[start + 12] >> 4);
      const totalSamples =
        (buf[start + 13] & 0x0f) * 2 ** 32 +
        buf.readUInt32BE(start + 14);
      if (rate > 0 && totalSamples > 0) out.lengthMs = String(Math.round((totalSamples / rate) * 1000));
    } else if (type === 4) {
      let p = start;
      const vendorLen = buf.readUInt32LE(p);
      p += 4 + vendorLen;
      const count = buf.readUInt32LE(p);
      p += 4;
      for (let i = 0; i < count && p + 4 <= start + size; i++) {
        const len = buf.readUInt32LE(p);
        p += 4;
        const text = new TextDecoder('utf-8').decode(buf.subarray(p, p + len));
        p += len;
        const eq = text.indexOf('=');
        if (eq < 0) continue;
        const key = text.slice(0, eq).toUpperCase();
        const value = text.slice(eq + 1).trim();
        if (!value) continue;
        if (key === 'TITLE' && !out.title) out.title = value;
        else if (key === 'ARTIST' && !out.artist) out.artist = value;
        else if (key === 'ALBUM' && !out.album) out.album = value;
        else if ((key === 'DATE' || key === 'YEAR') && !out.year) out.year = value;
      }
    }
    if (last) break;
    pos = start + size;
  }
  return Object.keys(out).length ? out : null;
}

/** Best-effort tag read. Only the file head plus the ID3v1 tail is touched. */
export async function readTags(absPath, ext) {
  let handle;
  try {
    handle = await open(absPath, 'r');
    const { size } = await handle.stat();
    const headLen = Math.min(HEAD_BYTES, size);
    const head = Buffer.alloc(headLen);
    await handle.read(head, 0, headLen, 0);

    let raw = null;
    if (ext === '.flac') raw = parseFlac(head);
    if (!raw) raw = parseId3v2(head);
    if (!raw && size > 128) {
      const tail = Buffer.alloc(128);
      await handle.read(tail, 0, 128, size - 128);
      raw = parseId3v1(tail);
    }
    if (!raw) return { state: 2 };

    const year = raw.year ? parseInt(String(raw.year).slice(0, 4), 10) : null;
    const lengthMs = raw.lengthMs ? parseInt(raw.lengthMs, 10) : null;
    return {
      state: 1,
      title: raw.title || null,
      artist: raw.artist || null,
      album: raw.album || null,
      year: Number.isFinite(year) ? year : null,
      durationMs: Number.isFinite(lengthMs) && lengthMs > 0 ? lengthMs : null
    };
  } catch {
    return { state: 2 };
  } finally {
    await handle?.close().catch(() => {});
  }
}
