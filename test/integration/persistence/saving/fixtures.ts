import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/constants";
import type { InkSnapshotV1 } from "../../../../src/domain/schema/public";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import type { AutosaveClock } from "../../../../src/persistence/saving/autosave/public";
import { type AutosaveDocumentSource } from "../../../../src/persistence/saving/autosave/types";
import type { MetadataGuardedFileRead } from "../../../../src/persistence/saving/save-ports";
import { rectangle, snapshot } from "../../../unit/persistence/worker/runtime/fixtures";

interface TimerEntry {
  readonly callback: () => void;
  readonly due: number;
  readonly id: number;
}

export class FakeClock implements AutosaveClock {
  #now = 0;
  #nextId = 0;
  readonly #timers = new Map<number, TimerEntry>();

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  setTimeout(callback: () => void, milliseconds: number): unknown {
    const id = ++this.#nextId;
    this.#timers.set(id, { callback, due: this.#now + milliseconds, id });
    return id;
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
    while (true) {
      const next = [...this.#timers.values()]
        .filter(({ due }) => due <= this.#now)
        .sort((left, right) => left.due - right.due || left.id - right.id)[0];
      if (next === undefined) return;
      this.#timers.delete(next.id);
      next.callback();
    }
  }
}

export class MemoryVault {
  content: string;
  processCount = 0;
  readCount = 0;
  readonly writtenContents: string[] = [];
  reportedSize: number | null = null;
  oversizedAfterWrite = false;
  failAfterWrite = false;
  processGate: Promise<void> | null = null;
  readGate: Promise<void> | null = null;
  readonly #processWaiters = new Set<{ readonly count: number; readonly resolve: () => void }>();
  readonly #readWaiters = new Set<{ readonly count: number; readonly resolve: () => void }>();

  public constructor(content: string) {
    this.content = content;
  }

  async create(_path: string, content: string): Promise<void> {
    this.content = content;
  }

  async process(_path: string, update: (current: string) => string): Promise<string> {
    this.processCount += 1;
    for (const waiter of this.#processWaiters) {
      if (this.processCount < waiter.count) continue;
      this.#processWaiters.delete(waiter);
      waiter.resolve();
    }
    if (this.processGate !== null) await this.processGate;
    this.content = update(this.content);
    this.writtenContents.push(this.content);
    if (this.failAfterWrite) throw new Error("indeterminate");
    return this.content;
  }

  async read(): Promise<string> {
    this.readCount += 1;
    for (const waiter of this.#readWaiters) {
      if (this.readCount < waiter.count) continue;
      this.#readWaiters.delete(waiter);
      waiter.resolve();
    }
    if (this.readGate !== null) await this.readGate;
    return this.content;
  }

  async readWithMetadataGuard(
    path: string,
    maximumBytes: number,
  ): Promise<MetadataGuardedFileRead> {
    const size = await this.size();
    if (size > maximumBytes) throw new RangeError("The vault file exceeds the input byte limit.");
    const content = await this.read();
    return {
      content,
      identity: { ctime: 1, mtime: 1, path, size },
      materialization: "host-full-read-not-bounded",
      stabilityEvidence: "object-identity-and-stat-unchanged",
    };
  }

  async size(): Promise<number> {
    if (this.reportedSize !== null) return this.reportedSize;
    if (this.oversizedAfterWrite && this.processCount > 0) {
      return FILE_SCHEMA_LIMITS.totalInputBytes + 1;
    }
    return new TextEncoder().encode(this.content).byteLength;
  }

  waitForProcessCount(count: number): Promise<void> {
    if (this.processCount >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#processWaiters.add({ count, resolve });
    });
  }

  waitForReadCount(count: number): Promise<void> {
    if (this.readCount >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#readWaiters.add({ count, resolve });
    });
  }
}

export class AutosaveDocumentFixture implements AutosaveDocumentSource {
  gestureActive = false;
  value: InkSnapshotV1 = snapshot();

  commit(revision: number, x: number): void {
    this.value = { ...this.value, elements: [rectangle(x)], revision };
  }

  commitPage(revision: number, page: InkSnapshotV1["page"]): void {
    this.value = { ...this.value, page, revision };
  }

  currentRevision(): number {
    return this.value.revision;
  }

  isGestureActive(): boolean {
    return this.gestureActive;
  }

  orderByBand() {
    return { content: this.value.elements.map(({ id }) => id) } as const;
  }

  snapshot(): InkSnapshotV1 {
    return this.value;
  }
}

export function serializeSnapshot(value: InkSnapshotV1 = snapshot()) {
  const result = serializeInkbookDocument(value);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
