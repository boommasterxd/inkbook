import { encodeBinaryResource } from "../serialization/binary-resource";
import type { ImageResourceV3 } from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { IMAGE_LIMITS } from "../../domain/images/image-limits";
import { ChunkedSha256 } from "../serialization/chunked-output-sha256";
import { SampleBase64Reader } from "../serialization/metadata/sample-base64";
import { inspectImageHeaderSteps } from "./image-header";

const validated = new WeakSet<ImageResourceV3>();
const BASE64_DECODE_CHARACTERS = 64 * 1024;
interface NativeBase64Target extends Uint8Array {
  setFromBase64?: (
    input: string,
    options: { readonly alphabet: "base64"; readonly lastChunkHandling: "strict" },
  ) => { readonly read: number; readonly written: number };
}

export async function createImageResource(
  bytes: Uint8Array,
  mimeType: ImageResourceV3["mimeType"],
  scheduler: WorkScheduler,
  signal?: AbortSignal,
  options?: { readonly requireLosslessWebp: boolean },
): Promise<ImageResourceV3> {
  const inspection = inspectImageHeaderSteps(bytes);
  let inspected = inspection.next();
  while (!inspected.done) {
    const pending = scheduler.checkpoint(signal, "background");
    if (pending !== undefined) await pending;
    signal?.throwIfAborted();
    inspected = inspection.next();
  }
  const header = inspected.value;
  if (header.mimeType !== mimeType) throw new RangeError("Image MIME type does not match content.");
  if (options?.requireLosslessWebp === true && header.lossless !== true)
    throw new RangeError("A lossless WebP resource is required.");
  const encoded = await encodeBinaryResource(bytes, scheduler, signal);
  const resource = Object.freeze({
    mimeType: header.mimeType,
    width: header.width,
    height: header.height,
    ...encoded,
  });
  validated.add(resource);
  return resource;
}

export function* decodeImageResourceSteps(
  resource: Pick<ImageResourceV3, "data">,
  signal?: AbortSignal,
): Generator<void, Uint8Array<ArrayBuffer>> {
  if (
    typeof resource.data !== "string" ||
    resource.data.length > Math.ceil(IMAGE_LIMITS.resourceBytes / 3) * 4
  )
    throw new RangeError("Image resource exceeds byte capacity.");
  const data = resource.data;
  const reader = new SampleBase64Reader(data);
  if (reader.byteLength > IMAGE_LIMITS.resourceBytes)
    throw new RangeError("Image resource exceeds byte capacity.");
  const bytes = new Uint8Array(reader.byteLength);
  const native = (bytes as NativeBase64Target).setFromBase64;
  if (typeof native === "function") {
    let written = 0;
    for (let offset = 0; offset < data.length; offset += BASE64_DECODE_CHARACTERS) {
      signal?.throwIfAborted();
      const part = data.slice(offset, offset + BASE64_DECODE_CHARACTERS);
      const final = offset + part.length === data.length;
      if (!(final ? /^[A-Za-z0-9+/]+={0,2}$/u : /^[A-Za-z0-9+/]+$/u).test(part))
        throw new RangeError("Invalid image resource Base64.");
      const decoded = native.call(bytes.subarray(written), part, {
        alphabet: "base64",
        lastChunkHandling: "strict",
      });
      const expected = Math.min((part.length / 4) * 3, bytes.length - written);
      if (decoded.read !== part.length || decoded.written !== expected)
        throw new RangeError("Invalid native image resource Base64 result.");
      written += decoded.written;
      yield;
    }
    return bytes;
  }
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    signal?.throwIfAborted();
    const end = Math.min(offset + 4096, bytes.length);
    for (let index = offset; index < end; index++) bytes[index] = reader.read();
    yield;
  }
  return bytes;
}

/** Only immutable objects validated in this realm can skip repeat payload hashing. */
export function* validateImageResourceSteps(
  resource: ImageResourceV3,
  signal?: AbortSignal,
): Generator<void> {
  signal?.throwIfAborted();
  if (validated.has(resource)) return;
  const bytes = yield* decodeImageResourceSteps(resource, signal);
  const header = yield* inspectImageHeaderSteps(bytes);
  const hash = new ChunkedSha256();
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    hash.update(bytes.subarray(offset, offset + 4096));
    signal?.throwIfAborted();
    yield;
  }
  if (
    hash.digestHex() !== resource.id ||
    header.mimeType !== resource.mimeType ||
    header.width !== resource.width ||
    header.height !== resource.height
  )
    throw new RangeError("Image resource identity or dimensions do not match content.");
  if (Object.isFrozen(resource)) validated.add(resource);
}

export function canonicalImageResource(resource: ImageResourceV3): ImageResourceV3 {
  if (validated.has(resource)) return resource;
  const copy = Object.freeze({
    id: resource.id,
    mimeType: resource.mimeType,
    width: resource.width,
    height: resource.height,
    data: resource.data,
  });
  return copy;
}
