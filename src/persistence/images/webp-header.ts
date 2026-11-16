interface Dimensions {
  readonly width: number;
  readonly height: number;
}

interface ExtendedHeader extends Dimensions {
  readonly flags: number;
}

interface WebpState {
  extended: ExtendedHeader | null;
  image: Dimensions | null;
  features: number;
  lossless: boolean;
}

interface WebpChunk {
  readonly kind: number;
  readonly start: number;
  readonly size: number;
}

interface WebpHeader extends Dimensions {
  readonly lossless: boolean;
}

/** RFC 9649 container admission only; native decoding remains authoritative for pixels. */
export function* inspectWebpHeaderSteps(view: DataView): Generator<void, WebpHeader | null> {
  if (view.getUint32(8) !== 0x57454250 || view.getUint32(4, true) !== view.byteLength - 8)
    return null;
  const state: WebpState = { extended: null, image: null, features: 0, lossless: false };
  let offset = 12;
  let checkpointOffset = offset + 4096;
  while (offset < view.byteLength) {
    if (offset + 8 > view.byteLength) return null;
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    const next = end + (size % 2);
    if (next > view.byteLength || (size % 2 === 1 && view.getUint8(end) !== 0)) return null;
    if (!admitChunk(view, { kind: view.getUint32(offset), start, size }, state)) return null;
    offset = next;
    // Even empty chunks consume eight bytes, bounding header visits between checkpoints.
    if (offset >= checkpointOffset) {
      yield;
      checkpointOffset = offset + 4096;
    }
  }
  if (state.extended !== null && !hasConsistentFeatures(state)) return null;
  return state.image === null ? null : { ...state.image, lossless: state.lossless };
}

function admitChunk(view: DataView, chunk: WebpChunk, state: WebpState): boolean {
  switch (chunk.kind) {
    case 0x56503858: // VP8X
      if (chunk.start !== 20 || chunk.size !== 10) return false;
      state.extended = extendedHeader(view, chunk.start);
      return state.extended !== null;
    case 0x56503820: // VP8
    case 0x5650384c: // VP8L
      return admitBitstream(view, chunk, state);
    case 0x414e494d: // ANIM
    case 0x414e4d46: // ANMF
      return false;
    case 0x414c5048: // ALPH
      return admitAlpha(view, chunk, state);
    case 0x49434350: // ICCP
      return state.image === null && (state.features & 0x10) === 0 && admitFeature(state, 0x20);
    case 0x45584946: // EXIF
      return admitFeature(state, 0x08);
    case 0x584d5020: // XMP
      return admitFeature(state, 0x04);
    default:
      return state.extended !== null || state.image !== null;
  }
}

function extendedHeader(view: DataView, start: number): ExtendedHeader | null {
  const flags = view.getUint8(start);
  if ((flags & 0xc3) !== 0 || readUint24(view, start + 1) !== 0) return null;
  const width = readUint24(view, start + 4) + 1;
  const height = readUint24(view, start + 7) + 1;
  return width * height > 0xffffffff ? null : { flags, width, height };
}

function admitBitstream(view: DataView, chunk: WebpChunk, state: WebpState): boolean {
  if (state.image !== null || (state.extended === null && chunk.start !== 20)) return false;
  state.lossless = chunk.kind === 0x5650384c;
  if (state.lossless && (state.features & 0x10) !== 0) return false;
  const image = state.lossless ? losslessHeader(view, chunk) : lossyHeader(view, chunk);
  if (image === null) return false;
  const canvas = state.extended ?? image;
  if (canvas.width !== image.width || canvas.height !== image.height) return false;
  state.image = image;
  return true;
}

function losslessHeader(view: DataView, chunk: WebpChunk): Dimensions | null {
  if (chunk.size <= 5 || view.getUint8(chunk.start) !== 0x2f) return null;
  const bits = view.getUint32(chunk.start + 1, true);
  if (bits >>> 29 !== 0) return null;
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

function lossyHeader(view: DataView, chunk: WebpChunk): Dimensions | null {
  if (chunk.size <= 10) return null;
  const tag = readUint24(view, chunk.start);
  if ((tag & 1) !== 0 || ((tag >>> 1) & 7) > 3 || (tag & 0x10) === 0) return null;
  const partitionSize = tag >>> 5;
  if (partitionSize === 0 || partitionSize >= chunk.size - 10) return null;
  if (readUint24(view, chunk.start + 3) !== 0x2a019d) return null;
  const width = view.getUint16(chunk.start + 6, true) & 0x3fff;
  const height = view.getUint16(chunk.start + 8, true) & 0x3fff;
  return width === 0 || height === 0 ? null : { width, height };
}

function admitAlpha(view: DataView, chunk: WebpChunk, state: WebpState): boolean {
  if (state.image !== null || chunk.size < 2 || !admitFeature(state, 0x10)) return false;
  const header = view.getUint8(chunk.start);
  if ((header & 0xc0) !== 0 || ((header >>> 4) & 3) > 1 || (header & 3) > 1) return false;
  const canvas = state.extended!;
  return (header & 3) === 1 || chunk.size === 1 + canvas.width * canvas.height;
}

function admitFeature(state: WebpState, flag: number): boolean {
  if (
    state.extended === null ||
    (state.extended.flags & flag) === 0 ||
    (state.features & flag) !== 0
  )
    return false;
  state.features |= flag;
  return true;
}

function hasConsistentFeatures(state: WebpState): boolean {
  // VP8L's alpha bit is only a hint; determining transparency requires native decoding.
  const mask = state.lossless ? 0x2c : 0x3c;
  return (state.extended!.flags & mask) === state.features;
}

function readUint24(view: DataView, start: number): number {
  return view.getUint16(start, true) + view.getUint8(start + 2) * 65536;
}
