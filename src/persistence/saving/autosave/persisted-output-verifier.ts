import { nextSafeCounter } from "../../worker/identity";
import type { PurposeOperationIdentity, VerifiedPersistedOutput } from "../../worker/protocol";
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

  async verify(content: string, purpose: VerificationPurpose): Promise<VerifiedPersistedOutput> {
    this.#assertLive();
    const identity = this.#operationIdentity(purpose);
    try {
      const persisted = await verifyExactWorkerContent(
        this.#options.executor(),
        identity,
        content,
        purpose === "read-back" ? "current" : "editable",
        this.#options.waitForBackground,
        this.#options.sliceBudgetMs,
      );
      this.#assertLive();
      return persisted;
    } catch {
      this.#assertLive();
      if (!this.#options.switchToFallback()) {
        throw new Error("Persisted output verification failed.");
      }
      const retryIdentity = this.#operationIdentity(purpose);
      const persisted = await verifyExactWorkerContent(
        this.#options.executor(),
        retryIdentity,
        content,
        purpose === "read-back" ? "current" : "editable",
        this.#options.waitForBackground,
        this.#options.sliceBudgetMs,
      );
      this.#assertLive();
      return persisted;
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
