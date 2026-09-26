import { nextSafeCounter } from "../../worker/identity";
import type {
  PurposeOperationIdentity,
  VaultBase,
  VerifiedPersistedOutput,
} from "../../worker/protocol";
import type { DocumentRuntimePort } from "../../worker/runtime/public";

import { verifyExactWorkerContent } from "./trusted-verification";

type VerificationPurpose = "preflight" | "read-back" | "verification";

interface AutosaveVerifierOptions {
  readonly sliceBudgetMs?: () => number;
  readonly waitForBackground?: () => Promise<void>;
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
    content: string,
    purpose: VerificationPurpose,
    confirmedBase?: VaultBase,
  ): Promise<VerifiedPersistedOutput> {
    this.#assertLive();
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
          ...(this.#options.waitForBackground
            ? { waitForBackground: this.#options.waitForBackground }
            : {}),
          ...(this.#options.sliceBudgetMs ? { sliceBudgetMs: this.#options.sliceBudgetMs } : {}),
          ...(confirmedBase ? { confirmedBase } : {}),
        },
      );
      this.#assertLive();
      return persisted;
    };
    try {
      return await verify(identity);
    } catch {
      this.#assertLive();
      if (!this.#options.switchToFallback()) {
        throw new Error("Persisted output verification failed.");
      }
      return verify(this.#operationIdentity(purpose));
    }
  }

  async verifyExpected(content: string, revision: number, hash: string): Promise<boolean> {
    const persisted = await this.verify(content, "read-back");
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
