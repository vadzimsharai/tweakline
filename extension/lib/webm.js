// MediaRecorder writes WebM without a duration, so players show 0:00 and cannot seek.
const EBML_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const INFO_ID = 0x1549a966;
const DURATION_ID = 0x4489;
const TIMECODE_SCALE_ID = 0x2ad7b1;
const DEFAULT_TIMECODE_SCALE = 1e6;
const NS_PER_MS = 1e6;
const WIDE_SIZE_BYTES = 8;
const BASE64_CHUNK = 0x8000;

function readId(bytes, at) {
  const first = bytes[at];
  const length = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0;
  if (!length || at + length > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + bytes[at + i];
  return { id, length };
}

function readSize(bytes, at) {
  const first = bytes[at];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || at + length > bytes.length) return null;
  let value = first & (0xff >> length);
  let unknown = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) unknown = false;
  }
  return { value: unknown ? Infinity : value, length };
}

function readElement(bytes, at) {
  const id = readId(bytes, at);
  if (!id) return null;
  const size = readSize(bytes, at + id.length);
  if (!size) return null;
  const dataStart = at + id.length + size.length;
  return { id: id.id, start: at, dataStart, end: size.value === Infinity ? Infinity : dataStart + size.value };
}

function readUint(bytes, from, to) {
  let value = 0;
  for (let i = from; i < to; i++) value = value * 256 + bytes[i];
  return value;
}

function float64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}

function wideSize(value) {
  const out = new Uint8Array(WIDE_SIZE_BYTES);
  out[0] = 0x01;
  let rest = value;
  for (let i = WIDE_SIZE_BYTES - 1; i > 0; i--) { out[i] = rest % 256; rest = Math.floor(rest / 256); }
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function findInfo(bytes) {
  const header = readElement(bytes, 0);
  if (!header || header.id !== EBML_ID || header.end === Infinity) return null;
  const segment = readElement(bytes, header.end);
  if (!segment || segment.id !== SEGMENT_ID) return null;
  const segmentEnd = Math.min(segment.end, bytes.length);
  for (let at = segment.dataStart; at < segmentEnd;) {
    const child = readElement(bytes, at);
    if (!child || child.end === Infinity) return null;
    if (child.id === INFO_ID) return child.end <= bytes.length ? child : null;
    at = child.end;
  }
  return null;
}

export function withWebmDuration(bytes, durationMs) {
  const info = findInfo(bytes);
  if (!info || !(durationMs > 0)) return bytes;
  let scale = DEFAULT_TIMECODE_SCALE;
  let duration = null;
  for (let at = info.dataStart; at < info.end;) {
    const child = readElement(bytes, at);
    if (!child || child.end > info.end) return bytes;
    if (child.id === TIMECODE_SCALE_ID) scale = readUint(bytes, child.dataStart, child.end) || DEFAULT_TIMECODE_SCALE;
    if (child.id === DURATION_ID) duration = child;
    at = child.end;
  }
  const value = (durationMs * NS_PER_MS) / scale;
  if (duration) {
    const out = bytes.slice();
    const width = duration.end - duration.dataStart;
    const view = new DataView(out.buffer, duration.dataStart, width);
    if (width === 8) view.setFloat64(0, value);
    else if (width === 4) view.setFloat32(0, value);
    else return bytes;
    return out;
  }
  const idBytes = bytes.subarray(info.start, info.start + (readId(bytes, info.start).length));
  const body = bytes.subarray(info.dataStart, info.end);
  const durationElement = concat([Uint8Array.of(0x44, 0x89, 0x88), float64(value)]);
  return concat([
    bytes.subarray(0, info.start),
    idBytes, wideSize(body.length + durationElement.length), body, durationElement,
    bytes.subarray(info.end),
  ]);
}

export function webmDataUrlWithDuration(dataUrl, durationMs) {
  const match = /^data:(video\/webm[^,]*);base64,(.*)$/s.exec(dataUrl);
  if (!match) return dataUrl;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const fixed = withWebmDuration(bytes, durationMs);
  if (fixed === bytes) return dataUrl;
  let text = '';
  for (let i = 0; i < fixed.length; i += BASE64_CHUNK) text += String.fromCharCode(...fixed.subarray(i, i + BASE64_CHUNK));
  return `data:${match[1]};base64,${btoa(text)}`;
}
