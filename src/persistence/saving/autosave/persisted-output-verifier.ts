import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { nextSafeCounter } from "../../worker/identity";
import type {
  PurposeOperationIdentity,
  VaultBase,
  VerifiedPersistedOutput,
} from "../../worker/protocol";
import type { DocumentRuntimePort } from "../../worker/runtime/public";

import { verifyExactWorkerContent } from "./trusted-verification";
import type { MetadataGuardedFileRead } from "../save-ports";

type VerificationPurpose = "preflight" | "read-back" | "verification";

interface AutosaveVerifierOptions {
  readonly workScheduler: WorkScheduler;
  readonly waitForBackground?: () => Promise<void> | undefined;
  readonly executor: () => DocumentRuntimePort;
  readonly isDisposed: () => boolean;
  readonly sessionId: string;
  readonly switchToFallback: () => boolean;
  readonly workerEpoch: () => number;
}

export class AutosavePersistedOutputVerifier {
  readonly #nextOperationByPurpose = new Map<VerificationPurpose, number>();
  readonly #options: AutosaveVerifierOptions;

  constructor(options: AutosaveVerifierOptions) {
    this.#options = options;
  }

  async verify(
    read: string | MetadataGuardedFileRead,
    purpose: VerificationPurpose,
    confirmedBase?: VaultBase,
  ): Promise<VerifiedPersistedOutput> {
    this.#assertLive();
    assertCurrentRead(read);
    const content = typeof read === "string" ? read : read.content;
    const identity = this.#operationIdentity(purpose);
    const verify = async (
      operation: PurposeOperationIdentity,
    ): Promise<VerifiedPersistedOutput> => {
      const persisted = await verifyExactWorkerContent(
        this.#options.executor(),
        operation,
        content,
        purpose === "read-back" ? "current" : "editable",
        {
          assertCurrent: () => {
            this.#assertLive();
            assertCurrentRead(read);
          },
          workScheduler: this.#options.workScheduler,
          ...(this.#options.waitForBackground
            ? { waitForBackground: this.#options.waitForBackground }
            : {}),
          ...(confirmedBase ? { confirmedBase } : {}),
          ...(typeof read === "string" ? {} : { expectedBytes: read.identity.size }),
        },
      );
      this.#assertLive();
      assertCurrentRead(read);
      return persisted;
    };
    try {
      return await verify(identity);
    } catch {
      this.#assertLive();
      assertCurrentRead(read);
      if (!this.#options.switchToFallback()) {
        throw new Error("Persisted output verification failed.");
      }
      return verify(this.#operationIdentity(purpose));
    }
  }

  async verifyExpected(
    read: string | MetadataGuardedFileRead,
    revision: number,
    hash: string,
  ): Promise<boolean> {
    const persisted = await this.verify(read, "read-back");
    return (
      persisted.type === "confirmed" &&
      persisted.revision === revision &&
      persisted.outputHash === hash
    );
  }

  resetOperationIdentities(): void {
    this.#nextOperationByPurpose.clear();
  }

  #operationIdentity(purpose: VerificationPurpose): PurposeOperationIdentity {
    const operationId = nextSafeCounter(
      this.#nextOperationByPurpose.get(purpose) ?? 0,
      "operationId",
    );
    this.#nextOperationByPurpose.set(purpose, operationId);
    return {
      operationId,
      purpose,
      sessionId: this.#options.sessionId,
      workerEpoch: this.#options.workerEpoch(),
    };
  }

  #assertLive(): void {
    if (this.#options.isDisposed()) {
      throw new Error("The autosave coordinator has been disposed.");
    }
  }
}

function assertCurrentRead(read: string | MetadataGuardedFileRead): void {
  if (typeof read !== "string" && read.isCurrent?.() === false) {
    throw new Error("The persisted-output host read is obsolete.");
  }
}
