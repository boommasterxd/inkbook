const MEBIBYTE = 1024 * 1024;

const ACTIVE_DOCUMENT_MEMORY_PRESSURE_BYTES = 96 * MEBIBYTE;
const ACTIVE_DOCUMENT_MEMORY_RELEASE_BYTES = 64 * MEBIBYTE;

export interface ActiveDocumentMemoryUsage {
  readonly anchorCacheBytes: number;
  readonly modelBytes: number;
  readonly motionCacheBytes: number;
  readonly pathCacheBytes: number;
}

export interface ActiveDocumentMemoryStorePort {
  memoryUsage(): Pick<ActiveDocumentMemoryUsage, "anchorCacheBytes" | "modelBytes">;
  setActiveDocumentMemoryPressure(active: boolean): void;
}

export interface ActiveDocumentMemoryScenePort {
  memoryUsage(): Pick<ActiveDocumentMemoryUsage, "motionCacheBytes" | "pathCacheBytes">;
  setActiveDocumentMemoryPressure(active: boolean): void;
}

interface ActiveDocumentMemoryCoordinatorOptions {
  readonly pressureBytes?: number;
  readonly releaseBytes?: number;
  readonly scene: ActiveDocumentMemoryScenePort;
  readonly store: ActiveDocumentMemoryStorePort;
}

/** Coordinates document-owned caches while reserving headroom below the mobile memory ceiling. */
export class ActiveDocumentMemoryCoordinator {
  #active = false;
  #released = false;
  readonly #options: ActiveDocumentMemoryCoordinatorOptions;
  readonly #pressureBytes: number;
  readonly #releaseBytes: number;

  public constructor(options: ActiveDocumentMemoryCoordinatorOptions) {
    this.#options = options;
    this.#pressureBytes = options.pressureBytes ?? ACTIVE_DOCUMENT_MEMORY_PRESSURE_BYTES;
    this.#releaseBytes = options.releaseBytes ?? ACTIVE_DOCUMENT_MEMORY_RELEASE_BYTES;
    assertThresholds(this.#pressureBytes, this.#releaseBytes);
  }

  public get active(): boolean {
    return this.#active;
  }

  public evaluate(): ActiveDocumentMemoryUsage {
    if (this.#released) return EMPTY_USAGE;
    const usage = { ...this.#options.store.memoryUsage(), ...this.#options.scene.memoryUsage() };
    const total = totalBytes(usage);
    const next = this.#active ? total > this.#releaseBytes : total >= this.#pressureBytes;
    if (next !== this.#active) this.apply(next);
    return usage;
  }

  public release(): void {
    if (this.#released) return;
    if (this.#active) this.apply(false);
    this.#released = true;
  }

  private apply(active: boolean): void {
    this.#active = active;
    this.#options.store.setActiveDocumentMemoryPressure(active);
    this.#options.scene.setActiveDocumentMemoryPressure(active);
  }
}

const EMPTY_USAGE: ActiveDocumentMemoryUsage = Object.freeze({
  anchorCacheBytes: 0,
  modelBytes: 0,
  motionCacheBytes: 0,
  pathCacheBytes: 0,
});

function totalBytes(usage: ActiveDocumentMemoryUsage): number {
  return usage.anchorCacheBytes + usage.modelBytes + usage.motionCacheBytes + usage.pathCacheBytes;
}

function assertThresholds(pressureBytes: number, releaseBytes: number): void {
  if (!Number.isSafeInteger(pressureBytes) || pressureBytes <= 0) {
    throw new RangeError("The active-document memory pressure threshold must be positive.");
  }
  if (!Number.isSafeInteger(releaseBytes) || releaseBytes < 0 || releaseBytes >= pressureBytes) {
    throw new RangeError("The active-document memory release threshold must be below pressure.");
  }
}
