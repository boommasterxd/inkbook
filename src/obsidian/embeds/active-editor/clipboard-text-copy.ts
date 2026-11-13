import type { ElementStore } from "../../../domain/store/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { CLIPBOARD_LIMITS } from "../../../persistence/clipboard/constants";
import type { ClipboardWritePort } from "../../../persistence/clipboard/public";

export interface TextCopyOptions<Item> {
  readonly isCurrent: () => boolean;
  readonly isSelectionCurrent: () => boolean;
  readonly port: Pick<ClipboardWritePort<Item>, "createItem" | "write">;
  readonly scheduler: WorkScheduler;
  readonly signal: AbortSignal;
  readonly selection: ReadonlySet<string>;
  readonly store: ElementStore;
  readonly timers: Pick<Window, "setTimeout" | "clearTimeout">;
}

export const TEXT_COPY_WRITE_TIMEOUT_MS = 5_000;

class PlainTextWriteError extends Error {}

export type TextCopyResult =
  | { readonly kind: "copied"; readonly source: string }
  | {
      readonly kind: "unavailable";
      readonly reason: "encode-failed" | "stale-operation" | "plain-system-write-failed";
    };

export function isTextOnlySelection(store: ElementStore, selection: ReadonlySet<string>): boolean {
  if (selection.size === 0) return false;
  for (const id of selection) if (store.get(id)?.element.kind !== "text") return false;
  return true;
}

/** Start the native write before any cooperative continuation loses user activation. */
export async function copyTextSelection<Item>(
  options: TextCopyOptions<Item>,
): Promise<TextCopyResult> {
  const preparation = new AbortController();
  const abortPreparation = () => preparation.abort();
  options.signal.addEventListener("abort", abortPreparation, { once: true });
  if (options.signal.aborted) abortPreparation();
  const sourceReady = selectedSource({
    ...options,
    isCurrent: () => !preparation.signal.aborted && options.isCurrent(),
    signal: preparation.signal,
  });
  const systemWrite = boundedWrite(beginPlainTextWrite(options.port, sourceReady), options);
  try {
    const [source] = await Promise.all([sourceReady, systemWrite.promise]);
    if (!options.isCurrent() || !options.isSelectionCurrent())
      return { kind: "unavailable", reason: "stale-operation" };
    return { kind: "copied", source };
  } catch (error) {
    return {
      kind: "unavailable",
      reason:
        !options.isCurrent() || !options.isSelectionCurrent()
          ? "stale-operation"
          : error instanceof PlainTextWriteError
            ? "plain-system-write-failed"
            : "encode-failed",
    };
  } finally {
    preparation.abort();
    options.signal.removeEventListener("abort", abortPreparation);
    systemWrite.cancel();
  }
}

/** I/O timeout and disposal bound a host write that may never settle. */
function boundedWrite<Item>(write: Promise<boolean>, options: TextCopyOptions<Item>) {
  const { signal, timers } = options;
  const completion: { finish?: (succeeded: boolean) => void } = {};
  let cancel: () => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: number | undefined;
    const finish = (succeeded: boolean) => {
      if (settled) return;
      settled = true;
      delete completion.finish;
      if (timeout !== undefined) timers.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (succeeded) resolve();
      else reject(new PlainTextWriteError("System clipboard write failed."));
    };
    const onAbort = () => finish(false);
    completion.finish = finish;
    cancel = onAbort;
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = timers.setTimeout(onAbort, TEXT_COPY_WRITE_TIMEOUT_MS);
    if (signal.aborted) onAbort();
    void write.then((succeeded) => completion.finish?.(succeeded));
  });
  return { cancel: () => cancel(), promise };
}

function beginPlainTextWrite<Item>(
  port: TextCopyOptions<Item>["port"],
  sourceReady: Promise<string>,
): Promise<boolean> {
  // Construction/write failures may leave the native data promise unconsumed.
  void sourceReady.catch(() => undefined);
  try {
    const item = port.createItem(new Map([["text/plain", sourceReady]]));
    return Promise.resolve(port.write([item])).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

async function selectedSource<Item>(options: TextCopyOptions<Item>): Promise<string> {
  const preparation = orderedSource(options.store, options.selection);
  let step = preparation.next();
  while (!step.done) {
    if (!options.isCurrent()) throw new Error("Text selection changed.");
    const wait = options.scheduler.checkpoint(options.signal, "frame");
    if (wait !== undefined) await wait;
    step = preparation.next();
  }
  if (!options.isCurrent() || !options.isSelectionCurrent())
    throw new Error("Text selection changed.");
  return step.value;
}

interface RankedSource {
  readonly rank: number;
  readonly source: string;
}

function* orderedSource(
  store: ElementStore,
  selection: ReadonlySet<string>,
): Generator<void, string> {
  if (selection.size === 0 || selection.size > CLIPBOARD_LIMITS.elements)
    throw new RangeError("Text selection exceeds its element limit.");
  const sources: RankedSource[] = [];
  let bytes = Math.max(0, selection.size - 1) * 2;
  const encoder = new TextEncoder();
  for (const id of selection) {
    const element = store.get(id)?.element;
    const rank = store.getRank(id);
    if (element?.kind !== "text" || rank === undefined)
      throw new Error("Text selection is unavailable.");
    bytes += encoder.encode(element.source).byteLength;
    if (bytes > CLIPBOARD_LIMITS.totalInputBytes)
      throw new RangeError("Text selection exceeds its byte limit.");
    sources.push({ rank: rank.rank, source: element.source });
    yield;
  }
  const ordered = yield* sortSources(sources);
  return ordered.map(({ source }) => source).join("\n\n");
}

function* sortSources(sources: RankedSource[]): Generator<void, RankedSource[]> {
  let input = sources;
  for (let width = 1; width < sources.length; width *= 2) {
    const output: RankedSource[] = [];
    for (let offset = 0; offset < sources.length; offset += width * 2) {
      const middle = Math.min(offset + width, sources.length);
      const end = Math.min(offset + width * 2, sources.length);
      let left = offset;
      let right = middle;
      while (left < middle || right < end) {
        if (right === end || (left < middle && input[left]!.rank <= input[right]!.rank))
          output.push(input[left++]!);
        else output.push(input[right++]!);
        yield;
      }
    }
    input = output;
  }
  return input;
}
