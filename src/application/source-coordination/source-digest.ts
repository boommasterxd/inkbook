import { commandFailure } from "../note-session/results";
import type { CommandResultV1, Sha256Digest } from "../note-session/types";
import { digestMarkdownSnapshot } from "./limits";
import type { SourceSnapshotV1, StreamingSha256PortV1 } from "./types";
import type { SourceDigestWorkPortV1 } from "./work-ports";

export class SourceDigestWorkOwnerV1 {
  #active: ActiveSourceDigestWorkV1 | null = null;
  readonly #digestPort: StreamingSha256PortV1;
  readonly #workPort: SourceDigestWorkPortV1;
  #disposed = false;

  constructor(
    digestPort: StreamingSha256PortV1,
    workPort: SourceDigestWorkPortV1,
  ) {
    this.#digestPort = digestPort;
    this.#workPort = workPort;
  }

  async digest(
    snapshot: SourceSnapshotV1,
  ): Promise<CommandResultV1<Sha256Digest>> {
    if (this.#disposed) return commandFailure("disposed");
    this.#cancelActive("stale-source");
    const active = createActiveSourceDigestWork();
    this.#active = active;
    try {
      const result = await Promise.race([
        digestMarkdownSnapshot(
          this.#digestPort,
          snapshot,
          this.#workPort,
          active.signal,
        ),
        active.cancellation,
      ]);
      if (this.#isDisposed()) return commandFailure("disposed");
      return this.#active === active ? result : commandFailure("stale-source");
    } finally {
      if (this.#active === active) this.#active = null;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelActive("disposed");
  }

  #isDisposed(): boolean {
    return this.#disposed;
  }

  #cancelActive(code: "disposed" | "stale-source"): void {
    const active = this.#active;
    if (active === null) return;
    this.#active = null;
    active.cancel(code);
  }
}

interface ActiveSourceDigestWorkV1 {
  readonly cancellation: Promise<CommandResultV1<Sha256Digest>>;
  readonly signal: AbortSignal;
  cancel(code: "disposed" | "stale-source"): void;
}

function createActiveSourceDigestWork(): ActiveSourceDigestWorkV1 {
  const controller = new AbortController();
  let resolveCancellation!: (result: CommandResultV1<Sha256Digest>) => void;
  const cancellation = new Promise<CommandResultV1<Sha256Digest>>((resolve) => {
    resolveCancellation = resolve;
  });
  return Object.freeze({
    cancellation,
    cancel: (code: "disposed" | "stale-source"): void => {
      if (controller.signal.aborted) return;
      controller.abort();
      resolveCancellation(commandFailure(code));
    },
    signal: controller.signal,
  });
}
