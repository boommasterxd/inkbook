import { calculateElementBounds } from "../../../domain/geometry/public";
import { FILE_SCHEMA_LIMITS } from "../../../domain/schema/public";
import { autoElementMarkupFragments } from "./auto-contrast-markup";
import { ChunkedOutputLimitError } from "./chunked-output-assembler";
import type { AutoPresentation, ElementFragments } from "./element-fragments";
import type { AutoPaintServer, AutoPaintServerRegistry } from "./auto-contrast-servers";

export function autoExportFragment(
  fragment: ElementFragments,
  servers?: AutoPaintServerRegistry,
): ElementFragments {
  const steps = autoExportFragmentSteps(fragment, undefined, servers);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Geometry payloads remain views of the immutable cached UTF-8, rather than second copies. */
export function* autoExportFragmentSteps(
  fragment: ElementFragments,
  signal?: AbortSignal,
  servers?: AutoPaintServerRegistry,
): Generator<void, ElementFragments> {
  signal?.throwIfAborted();
  const plan =
    fragment.autoPresentation === undefined
      ? yield* prepareAutoPresentationSteps(fragment, signal)
      : fragment.autoPresentation;
  if (plan === null) return fragment;
  for (const server of plan.servers) {
    servers?.add(server);
    yield;
    signal?.throwIfAborted();
  }
  if (fragment.presentation !== undefined) return fragment;
  const decoder = new TextDecoder();
  return Object.create(fragment, {
    autoPresentation: { value: plan },
    bytes: { value: fragment.metadataBytes + plan.bytes },
    presentation: { value: { chunks: plan.chunks } },
    svg: { get: () => plan.chunks.map((chunk) => decoder.decode(chunk)).join("") },
  }) as ElementFragments;
}

export function* prepareAutoPresentationSteps(
  fragment: ElementFragments,
  signal?: AbortSignal,
): Generator<void, AutoPresentation | null> {
  signal?.throwIfAborted();
  if (fragment.autoPresentation !== undefined) return fragment.autoPresentation;
  if (fragment.element.kind === "image") return null;
  const markup = fragment.svg;
  if (!markup.includes('class="inkbook-theme-')) return null;
  const encoder = new TextEncoder();
  const serverByKey = new Map<string, AutoPaintServer>();
  const registry = {
    add: (server: AutoPaintServer) => {
      serverByKey.set(server.key, server);
    },
  };
  const chunks: Uint8Array[] = [];
  const pathRanges = fragment.strokePaths;
  let path = 0;
  let bytes = 0;
  let retainedBytes = 128;
  const append = (chunk: Uint8Array) => {
    bytes += chunk.byteLength;
    if (bytes > FILE_SCHEMA_LIMITS.totalInputBytes) throw new ChunkedOutputLimitError();
    retainedBytes += 64;
    if (chunk.buffer !== fragment.svgUtf8.buffer) retainedBytes += chunk.byteLength;
    chunks.push(chunk);
  };
  const bounds = fragment.bounds ?? calculateElementBounds(fragment.element);
  for (const text of autoElementMarkupFragments(fragment.element, markup, bounds, registry)) {
    signal?.throwIfAborted();
    const start = pathRanges === undefined ? -1 : text.indexOf('<path d="');
    const range = start < 0 ? undefined : pathRanges?.[path++];
    if (range === undefined) append(encoder.encode(text));
    else {
      const data = start + '<path d="'.length;
      const end = text.indexOf('"', data);
      append(encoder.encode(text.slice(0, data)));
      append(fragment.svgUtf8.subarray(range.start, range.end));
      append(encoder.encode(text.slice(end)));
    }
    yield;
    signal?.throwIfAborted();
  }
  const servers = Object.freeze([...serverByKey.values()]);
  retainedBytes += servers.length * 512;
  return Object.freeze({ chunks: Object.freeze(chunks), servers, bytes, retainedBytes });
}
