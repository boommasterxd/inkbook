import type {
  NoteSessionTurnResultV1,
  Sha256Digest,
  SourceGeneration,
  ViewId,
} from "../../application/note-session";
import type { RuntimeMarkerCheckpointCorrelationV1 } from "./runtime-first-sidecar";

const MAX_MARKER_OBSERVATIONS = 8;

export interface RuntimeMarkerObservationV1 {
  readonly completion: Promise<NoteSessionTurnResultV1>;
  readonly priorDigest: Sha256Digest;
  readonly priorGeneration: SourceGeneration;
  readonly viewId: ViewId;
}

interface MarkerWaiterV1 {
  readonly correlation: RuntimeMarkerCheckpointCorrelationV1;
  readonly cleanup: () => void;
  readonly resolve: (observation: RuntimeMarkerObservationV1 | null) => void;
}

export class RuntimeSourceMarkerObservationsV1 {
  readonly #pending: RuntimeMarkerCheckpointCorrelationV1[] = [];
  readonly #claimed = new Set<RuntimeMarkerCheckpointCorrelationV1>();
  readonly #rejected = new Set<RuntimeMarkerCheckpointCorrelationV1>();
  readonly #observations: RuntimeMarkerObservationV1[] = [];
  readonly #waiters: MarkerWaiterV1[] = [];

  public get candidate(): RuntimeMarkerCheckpointCorrelationV1 | null {
    return this.#pending[0] ?? null;
  }

  public begin(correlation: RuntimeMarkerCheckpointCorrelationV1): boolean {
    if (
      this.#pending.length >= MAX_MARKER_OBSERVATIONS ||
      this.#pending.some((candidate) => sameCommand(candidate, correlation))
    ) {
      return false;
    }
    this.#pending.push(correlation);
    return true;
  }

  public cancel(correlation: RuntimeMarkerCheckpointCorrelationV1): void {
    const index = this.#pending.findIndex((candidate) =>
      sameCommand(candidate, correlation),
    );
    if (index >= 0) this.#pending.splice(index, 1);
  }

  public claim(correlation: RuntimeMarkerCheckpointCorrelationV1): boolean {
    const index = this.#pending.indexOf(correlation);
    if (index < 0) return false;
    this.#pending.splice(index, 1);
    this.#rejected.delete(correlation);
    this.#claimed.add(correlation);
    return true;
  }

  public reject(
    correlation: RuntimeMarkerCheckpointCorrelationV1 | null,
  ): void {
    if (correlation === null) return;
    this.cancel(correlation);
    this.#rejected.add(correlation);
    while (this.#rejected.size > MAX_MARKER_OBSERVATIONS) {
      const oldest = this.#rejected.values().next().value;
      if (oldest === undefined) break;
      this.#rejected.delete(oldest);
    }
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index];
      if (
        waiter === undefined ||
        !sameCommand(waiter.correlation, correlation)
      ) {
        continue;
      }
      this.#waiters.splice(index, 1);
      waiter.resolve(null);
    }
  }

  public rememberClaim(
    correlation: RuntimeMarkerCheckpointCorrelationV1,
    observation: RuntimeMarkerObservationV1,
  ): void {
    if (!this.#claimed.delete(correlation)) return;
    this.#observations.push(observation);
    while (this.#observations.length > MAX_MARKER_OBSERVATIONS) {
      this.#observations.shift();
    }
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index];
      if (waiter === undefined || !matches(observation, waiter.correlation)) {
        continue;
      }
      this.#waiters.splice(index, 1);
      waiter.resolve(observation);
    }
  }

  public wait(
    signal: AbortSignal,
    correlation: RuntimeMarkerCheckpointCorrelationV1,
  ): Promise<RuntimeMarkerObservationV1 | null> {
    if (this.#rejected.delete(correlation)) return Promise.resolve(null);
    const existing = this.#observations.find((observation) =>
      matches(observation, correlation),
    );
    if (existing !== undefined) return Promise.resolve(existing);
    if (signal.aborted || this.#waiters.length >= MAX_MARKER_OBSERVATIONS) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = (): void => signal.removeEventListener("abort", abort);
      const settle = (observation: RuntimeMarkerObservationV1 | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(observation);
      };
      const waiter: MarkerWaiterV1 = {
        cleanup,
        correlation,
        resolve: settle,
      };
      const abort = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        settle(null);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  public dispose(): void {
    this.#pending.length = 0;
    this.#claimed.clear();
    this.#rejected.clear();
    this.#observations.length = 0;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.cleanup();
      waiter.resolve(null);
    }
  }
}

function matches(
  observation: RuntimeMarkerObservationV1,
  correlation: RuntimeMarkerCheckpointCorrelationV1,
): boolean {
  return (
    observation.priorDigest === correlation.priorSourceDigest &&
    Number(observation.priorGeneration) ===
      Number(correlation.priorSourceGeneration)
  );
}

function sameCommand(
  left: RuntimeMarkerCheckpointCorrelationV1,
  right: RuntimeMarkerCheckpointCorrelationV1,
): boolean {
  return (
    left.command.operationId === right.command.operationId &&
    left.command.historyEntryId === right.command.historyEntryId
  );
}
