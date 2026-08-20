import type { NoteSessionTurnResultV1 } from "./queue";

interface DeferredV1<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export interface IdentityRekeyControlV1 {
  readonly admitted: DeferredV1<boolean>;
  readonly prepared: DeferredV1<boolean>;
  readonly committed: DeferredV1<boolean>;
  readonly prepareDecision: DeferredV1<boolean>;
  readonly commitDecision: DeferredV1<boolean>;
  readonly finalDecision: DeferredV1<boolean>;
}

export interface NoteSessionIdentityRekeyHandleV1 {
  readonly admitted: Promise<boolean>;
  readonly prepared: Promise<boolean>;
  readonly committed: Promise<boolean>;
  readonly completion: Promise<NoteSessionTurnResultV1>;
  startPreparation(): void;
  startCommit(): void;
  finish(commit: boolean): void;
  cancel(): void;
}

export function createIdentityRekeyControl(): IdentityRekeyControlV1 {
  return {
    admitted: deferred<boolean>(),
    commitDecision: deferred<boolean>(),
    committed: deferred<boolean>(),
    finalDecision: deferred<boolean>(),
    prepareDecision: deferred<boolean>(),
    prepared: deferred<boolean>(),
  };
}

export function createIdentityRekeyHandle(
  control: IdentityRekeyControlV1,
  completion: Promise<NoteSessionTurnResultV1>,
): NoteSessionIdentityRekeyHandleV1 {
  const cancel = (): void => {
    control.prepareDecision.resolve(false);
    control.commitDecision.resolve(false);
    control.finalDecision.resolve(false);
  };
  return Object.freeze({
    admitted: control.admitted.promise,
    cancel,
    committed: control.committed.promise,
    completion,
    finish: (commit: boolean): void => control.finalDecision.resolve(commit),
    prepared: control.prepared.promise,
    startCommit: (): void => control.commitDecision.resolve(true),
    startPreparation: (): void => control.prepareDecision.resolve(true),
  });
}

export function rejectIdentityRekey(control: IdentityRekeyControlV1): void {
  control.prepared.resolve(false);
  control.committed.resolve(false);
}

function deferred<T>(): DeferredV1<T> {
  let settle: (value: T) => void = missingDeferredResolution;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

function missingDeferredResolution(): never {
  throw new Error("A deferred rekey decision was not initialized.");
}
