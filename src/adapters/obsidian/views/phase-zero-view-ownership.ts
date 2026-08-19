import {
  RESOURCE_CATEGORIES_V1,
  type BatchResourceHandleV1,
  type ResourceAdmissionHandleV1,
  type ResourceAdmissionRequestV1,
  type ResourceCategoryV1,
  type ResourceCoordinatorV1,
  type ResourceResidencyV1,
} from "../../../application/resource-coordinator";
import type { Disposable } from "./contracts";

const ROOT_NODE_COUNT = 3;
const EVENT_LISTENER_COUNT = 12;
const READING_CATEGORIES = [
  RESOURCE_CATEGORIES_V1.readingViewChild,
  RESOURCE_CATEGORIES_V1.readingViewReport,
  RESOURCE_CATEGORIES_V1.readingViewObserver,
] as const;

interface ReadingGenerationRecord {
  readonly generation: number;
  readonly handle: BatchResourceHandleV1;
}

export class PhaseZeroViewOwnership implements Disposable {
  readonly #pointerCaptures = new Map<number, ResourceAdmissionHandleV1>();
  readonly #readingGenerations = new Map<string, ReadingGenerationRecord>();
  readonly #readingHandles = new Set<BatchResourceHandleV1>();
  #disposed = false;

  private constructor(
    private readonly coordinator: ResourceCoordinatorV1,
    private readonly ownerId: string,
    private readonly staticHandle: BatchResourceHandleV1,
  ) {}

  public static reserve(
    coordinator: ResourceCoordinatorV1,
    ownerId: string,
  ): PhaseZeroViewOwnership | undefined {
    const handle = admitBatch(
      coordinator,
      ownerId,
      [
        [RESOURCE_CATEGORIES_V1.attachedView, 1],
        [RESOURCE_CATEGORIES_V1.domNode, ROOT_NODE_COUNT],
        [RESOURCE_CATEGORIES_V1.listener, EVENT_LISTENER_COUNT],
      ],
      "steady",
    );
    if (handle?.activate() !== true) {
      handle?.release();
      return undefined;
    }
    return new PhaseZeroViewOwnership(coordinator, ownerId, handle);
  }

  public capturePointer(
    pointerId: number,
    capture: (pointerId: number) => void,
    release: (pointerId: number) => void,
  ): boolean {
    if (this.#disposed) return false;
    if (this.#pointerCaptures.has(pointerId)) return true;
    const handle = this.#admit(
      RESOURCE_CATEGORIES_V1.pointerCapture,
      1,
      "transient",
    );
    if (handle === undefined) return false;
    try {
      capture(pointerId);
    } catch {
      handle.release();
      return false;
    }
    if (!handle.activate()) {
      safelyRun(() => release(pointerId));
      handle.release();
      return false;
    }
    this.#pointerCaptures.set(pointerId, handle);
    return true;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const handle of this.#pointerCaptures.values()) handle.release();
    this.#pointerCaptures.clear();
    for (const handle of this.#readingHandles) handle.release();
    this.#readingHandles.clear();
    this.#readingGenerations.clear();
    this.staticHandle.release();
  }

  public prepareReadingGeneration(
    sectionIdentity: string,
    generation: number,
  ): ReadingGenerationReservation | undefined {
    if (this.#disposed) return undefined;
    const current = this.#readingGenerations.get(sectionIdentity);
    const handle = admitBatch(
      this.coordinator,
      this.ownerId,
      READING_CATEGORIES.map((category) => [category, 1] as const),
      "steady",
    );
    if (handle?.activate() !== true) {
      handle?.release();
      return undefined;
    }
    this.#readingHandles.add(handle);
    return new ReadingGenerationReservation(
      this,
      sectionIdentity,
      generation,
      current?.generation,
      handle,
    );
  }

  public releaseAllPointers(release: (pointerId: number) => void): void {
    for (const pointerId of [...this.#pointerCaptures.keys()]) {
      this.releasePointer(pointerId, release);
    }
  }

  public releasePointer(
    pointerId: number,
    release: (pointerId: number) => void,
  ): boolean {
    const handle = this.#pointerCaptures.get(pointerId);
    if (handle === undefined) return false;
    this.#pointerCaptures.delete(pointerId);
    safelyRun(() => release(pointerId));
    handle.release();
    return true;
  }

  public reserveTimer(): Disposable | undefined {
    if (this.#disposed) return undefined;
    const handle = this.#admit(RESOURCE_CATEGORIES_V1.timer, 1, "transient");
    if (handle?.activate() !== true) {
      handle?.release();
      return undefined;
    }
    return new AdmissionLease(handle);
  }

  public commitReadingGeneration(
    reservation: ReadingGenerationReservation,
  ): boolean {
    if (this.#disposed) return false;
    const current = this.#readingGenerations.get(reservation.sectionIdentity);
    const generationOwner = readingOwnerId(
      this.ownerId,
      reservation.sectionIdentity,
      reservation.generation,
    );
    const currentMatches =
      reservation.expectedGeneration === undefined
        ? current === undefined
        : current?.generation === reservation.expectedGeneration;
    if (!currentMatches || !reservation.handle.transfer(generationOwner)) {
      return false;
    }
    this.#readingGenerations.set(reservation.sectionIdentity, {
      generation: reservation.generation,
      handle: reservation.handle,
    });
    return true;
  }

  public releaseReadingGeneration(
    sectionIdentity: string,
    generation: number,
    handle: BatchResourceHandleV1,
  ): void {
    const current = this.#readingGenerations.get(sectionIdentity);
    if (current?.generation === generation && current.handle === handle) {
      this.#readingGenerations.delete(sectionIdentity);
    }
    this.#readingHandles.delete(handle);
    handle.release();
  }

  #admit(
    category: ResourceCategoryV1,
    count: number,
    residency: ResourceResidencyV1,
  ): ResourceAdmissionHandleV1 | undefined {
    const result = this.coordinator.admit(
      request(this.ownerId, category, count, residency),
    );
    return result.kind === "admitted" ? result.handle : undefined;
  }

  public cancelReadingGeneration(handle: BatchResourceHandleV1): void {
    this.#readingHandles.delete(handle);
    handle.release();
  }
}

export class ReadingGenerationReservation {
  #settled = false;

  public constructor(
    private readonly ownership: PhaseZeroViewOwnership,
    public readonly sectionIdentity: string,
    public readonly generation: number,
    public readonly expectedGeneration: number | undefined,
    public readonly handle: BatchResourceHandleV1,
  ) {}

  public cancel(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.ownership.cancelReadingGeneration(this.handle);
  }

  public commit(): boolean {
    if (this.#settled) return false;
    this.#settled = true;
    const committed = this.ownership.commitReadingGeneration(this);
    if (!committed) this.ownership.cancelReadingGeneration(this.handle);
    return committed;
  }

  public release(): void {
    if (!this.#settled) {
      this.cancel();
      return;
    }
    this.ownership.releaseReadingGeneration(
      this.sectionIdentity,
      this.generation,
      this.handle,
    );
  }
}

class AdmissionLease implements Disposable {
  #disposed = false;

  public constructor(private readonly handle: ResourceAdmissionHandleV1) {}

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.handle.release();
  }
}

function admitBatch(
  coordinator: ResourceCoordinatorV1,
  ownerId: string,
  resources: readonly (readonly [ResourceCategoryV1, number])[],
  residency: ResourceResidencyV1,
): BatchResourceHandleV1 | undefined {
  const result = coordinator.admitBatch({
    operations: resources.map(([category, count]) =>
      request(ownerId, category, count, residency),
    ),
  });
  return result.kind === "admitted" ? result.handle : undefined;
}

function readingOwnerId(
  ownerId: string,
  sectionIdentity: string,
  generation: number,
): string {
  return `${ownerId}:section:${sectionIdentity}:${String(generation)}`;
}

function request(
  ownerId: string,
  category: ResourceCategoryV1,
  count: number,
  residency: ResourceResidencyV1,
): ResourceAdmissionRequestV1 {
  return {
    bytes: 0,
    category,
    count,
    disposition: "suspend" as const,
    ownerId,
    residency,
    scope: { id: ownerId, kind: "view" as const },
  };
}

function safelyRun(action: () => void): void {
  try {
    action();
  } catch {
    // Resource release remains exact when the host already removed it.
  }
}
