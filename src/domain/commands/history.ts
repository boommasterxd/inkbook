export const DEFAULT_HISTORY_COMMAND_LIMIT = 200;
export const DEFAULT_HISTORY_BYTE_LIMIT = 64 * 1024 * 1024;

interface RetainedPayload {
  readonly payloadBytes: number;
}

export interface HistoryCommand<State> extends RetainedPayload {
  apply(state: State): State;
  revert(state: State): State;
}

export interface HistoryLimits {
  readonly maxCommands?: number;
  readonly maxBytes?: number;
}

export interface HistoryTransition<State> {
  readonly state: State;
  readonly changed: boolean;
}

export interface AppliedHistoryCommand extends RetainedPayload {
  readonly redo: () => Promise<boolean>;
  readonly undo: () => Promise<boolean>;
}

export interface AppliedSynchronousHistoryCommand extends RetainedPayload {
  readonly redo: () => boolean;
  readonly undo: () => boolean;
}

type RetainedAppliedHistoryCommand =
  | (AppliedHistoryCommand & { readonly kind: "async" })
  | (AppliedSynchronousHistoryCommand & { readonly kind: "sync" });

function validateLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

class RetainedHistory<Command extends RetainedPayload> {
  readonly #commands: Command[] = [];
  readonly #maxBytes: number;
  readonly #maxCommands: number;
  #cursor = 0;
  #retainedBytes = 0;

  public constructor(limits: HistoryLimits) {
    this.#maxCommands = limits.maxCommands ?? DEFAULT_HISTORY_COMMAND_LIMIT;
    this.#maxBytes = limits.maxBytes ?? DEFAULT_HISTORY_BYTE_LIMIT;
    validateLimit(this.#maxCommands, "maxCommands");
    validateLimit(this.#maxBytes, "maxBytes");
  }

  public get canUndo(): boolean {
    return this.#cursor > 0;
  }

  public get canRedo(): boolean {
    return this.#cursor < this.#commands.length;
  }

  public get commandCount(): number {
    return this.#commands.length;
  }

  public get retainedBytes(): number {
    return this.#retainedBytes;
  }

  public get undoCandidate(): Command | undefined {
    return this.#commands[this.#cursor - 1];
  }

  public get redoCandidate(): Command | undefined {
    return this.#commands[this.#cursor];
  }

  public register(command: Command): void {
    validateLimit(command.payloadBytes, "payloadBytes");
    const discarded = this.#commands.splice(this.#cursor);
    for (const item of discarded) this.#retainedBytes -= item.payloadBytes;
    this.#commands.push(command);
    this.#cursor += 1;
    this.#retainedBytes += command.payloadBytes;
    this.#enforceLimits();
  }

  public markUndone(): void {
    if (!this.canUndo) throw new Error("History cannot move before its oldest command.");
    this.#cursor -= 1;
  }

  public markRedone(): void {
    if (!this.canRedo) throw new Error("History cannot move beyond its newest command.");
    this.#cursor += 1;
  }

  public clear(): void {
    this.#commands.length = 0;
    this.#cursor = 0;
    this.#retainedBytes = 0;
  }

  #enforceLimits(): void {
    while (this.#commands.length > this.#maxCommands || this.#retainedBytes > this.#maxBytes) {
      const discarded = this.#commands.shift();
      if (discarded === undefined) return;
      this.#retainedBytes -= discarded.payloadBytes;
      this.#cursor = Math.max(0, this.#cursor - 1);
    }
  }
}

abstract class HistoryView<Command extends RetainedPayload> {
  protected readonly retained: RetainedHistory<Command>;

  protected constructor(limits: HistoryLimits) {
    this.retained = new RetainedHistory(limits);
  }

  public get canUndo(): boolean {
    return this.retained.canUndo;
  }

  public get canRedo(): boolean {
    return this.retained.canRedo;
  }

  public get commandCount(): number {
    return this.retained.commandCount;
  }

  public get retainedBytes(): number {
    return this.retained.retainedBytes;
  }
}

export class AppliedCommandHistory extends HistoryView<RetainedAppliedHistoryCommand> {
  #pendingOperations = 0;
  #queue: Promise<void> = Promise.resolve();

  public constructor(limits: HistoryLimits = {}) {
    super(limits);
  }

  public get isTraversing(): boolean {
    return this.#pendingOperations > 0;
  }

  public registerApplied(command: AppliedHistoryCommand): void {
    this.#assertIdle("register an applied command");
    this.retained.register({ ...command, kind: "async" });
  }

  public registerAppliedSync(command: AppliedSynchronousHistoryCommand): void {
    this.#assertIdle("register an applied command");
    this.retained.register({ ...command, kind: "sync" });
  }

  public undo(): Promise<boolean> {
    return this.#enqueue(() => this.#traverse("undo"));
  }

  public redo(): Promise<boolean> {
    return this.#enqueue(() => this.#traverse("redo"));
  }

  public undoSync(): boolean {
    return this.#traverseSync("undo");
  }

  public redoSync(): boolean {
    return this.#traverseSync("redo");
  }

  public clear(): void {
    this.#assertIdle("clear history");
    this.retained.clear();
  }

  #enqueue(operation: () => Promise<boolean>): Promise<boolean> {
    this.#pendingOperations += 1;
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.#pendingOperations -= 1;
    });
  }

  async #traverse(direction: "redo" | "undo"): Promise<boolean> {
    const command = this.#candidate(direction);
    if (command === undefined || !(await command[direction]())) return false;
    this.#mark(direction);
    return true;
  }

  #traverseSync(direction: "redo" | "undo"): boolean {
    if (this.isTraversing) return false;
    const command = this.#candidate(direction);
    if (command?.kind !== "sync" || !command[direction]()) return false;
    this.#mark(direction);
    return true;
  }

  #candidate(direction: "redo" | "undo"): RetainedAppliedHistoryCommand | undefined {
    return direction === "undo" ? this.retained.undoCandidate : this.retained.redoCandidate;
  }

  #mark(direction: "redo" | "undo"): void {
    if (direction === "undo") this.retained.markUndone();
    else this.retained.markRedone();
  }

  #assertIdle(action: string): void {
    if (this.#pendingOperations > 0) {
      throw new Error(`Cannot ${action} during an Undo or Redo operation.`);
    }
  }
}

export class CommandHistory<State> extends HistoryView<HistoryCommand<State>> {
  public constructor(limits: HistoryLimits = {}) {
    super(limits);
  }

  public execute(state: State, command: HistoryCommand<State>): HistoryTransition<State> {
    validateLimit(command.payloadBytes, "payloadBytes");
    const nextState = command.apply(state);
    if (Object.is(nextState, state)) return { state, changed: false };
    this.retained.register(command);
    return { state: nextState, changed: true };
  }

  public undo(state: State): HistoryTransition<State> {
    const command = this.retained.undoCandidate;
    if (command === undefined) return { state, changed: false };
    const previousState = command.revert(state);
    this.retained.markUndone();
    return { state: previousState, changed: true };
  }

  public redo(state: State): HistoryTransition<State> {
    const command = this.retained.redoCandidate;
    if (command === undefined) return { state, changed: false };
    const nextState = command.apply(state);
    this.retained.markRedone();
    return { state: nextState, changed: true };
  }

  public clear(): void {
    this.retained.clear();
  }
}
