import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";
import { parseSafeSvgRoot } from "../documents/svg-envelope-root";
import { parseOpeningTag } from "../documents/svg-tag";
import {
  adoptUtf8OutputWithPrefix,
  UTF8_OUTPUT_PREFIX_CODE_UNITS,
  type Utf8AdoptionOptions,
} from "./utf8-adoption";
import { isNativeArrayBuffer } from "../serialization/transfer-array";

const HASH = /^[0-9a-f]{64}$/u;

/** Adopts output from our bounded canonical serializer, never an external SVG. */
export async function adoptOwnedSvgOutput(
  output: string | Uint8Array,
  outputHash: string,
  options: Utf8AdoptionOptions & {
    readonly waitForBackground?: () => Promise<void> | undefined;
  } = {},
) {
  options.signal?.throwIfAborted();
  assertOwnedOutput(output, outputHash);
  const ready = options.waitForBackground?.();
  if (ready !== undefined) await ready;
  options.signal?.throwIfAborted();
  const { content, prefix } = await adoptUtf8OutputWithPrefix(output, options);
  options.signal?.throwIfAborted();
  return describeOwnedOutput(content, outputHash, prefix);
}

export function adoptOwnedSvgOutputSync(output: string | Uint8Array, outputHash: string) {
  assertOwnedOutput(output, outputHash);
  const content =
    typeof output === "string" ? output : new TextDecoder("utf-8", { fatal: true }).decode(output);
  return describeOwnedOutput(content, outputHash);
}

function assertOwnedOutput(output: string | Uint8Array, outputHash: string): void {
  if (!HASH.test(outputHash)) throw new TypeError("Invalid canonical output hash.");
  if (
    typeof output !== "string" &&
    (!isNativeArrayBuffer(output.buffer) ||
      output.byteOffset !== 0 ||
      output.byteLength !== output.buffer.byteLength)
  )
    throw new TypeError("Canonical output must exclusively own a full-span ArrayBuffer.");
  // The canonical serializer enforces UTF-8 byte capacity before producing strings.
  const size = typeof output === "string" ? output.length : output.byteLength;
  if (size > FILE_SCHEMA_LIMITS.totalInputBytes) {
    throw new RangeError("Canonical output exceeds the 64 MiB document limit.");
  }
}

function describeOwnedOutput(
  content: string,
  outputHash: string,
  prefix = content.slice(0, UTF8_OUTPUT_PREFIX_CODE_UNITS),
) {
  const tag = parseOpeningTag(prefix, 0);
  const root = tag === null ? null : parseSafeSvgRoot(tag, "current");
  if (root === null) throw new TypeError("Invalid canonical SVG root.");
  return {
    content,
    outputHash,
    lockedHeight: root.height,
    revision: root.revision,
    snapshotHash: root.snapshotHash,
  };
}
