declare function setImmediate(callback: () => void): void;

export class FallbackSliceProbe {
  yields = 0;
  readonly operations = new Map<string, OperationMeasurement>();
  #currentOperation = "idle";
  #inputQueryPhase = 0;
  #sliceBytes = 0;
  #inputWasObserved = false;
  readonly #wait: () => Promise<void>;

  public constructor(
    wait: () => Promise<void> = () => new Promise<void>((resolve) => setImmediate(resolve)),
  ) {
    this.#wait = wait;
  }

  public isInputActive = (): boolean => {
    if (this.#currentOperation === "idle") return false;
    const active = this.#inputQueryPhase < 2;
    this.#inputQueryPhase = (this.#inputQueryPhase + 1) % 4;
    this.#inputWasObserved = active;
    return active;
  };

  public startOperation(name: string): void {
    this.#currentOperation = name;
    this.operations.set(name, {
      yields: 0,
      totalBytes: 0,
      maximumSliceBytes: 0,
      inputPauseYields: 0,
      syntheticInputSamples: 0,
    });
    this.#inputQueryPhase = 0;
    this.#inputWasObserved = false;
  }

  public recordBytes(bytes: number): void {
    const operation = this.operations.get(this.#currentOperation);
    if (operation === undefined) return;
    operation.totalBytes += bytes;
    this.#sliceBytes += bytes;
  }

  #finishSlice(): void {
    const operation = this.operations.get(this.#currentOperation);
    if (operation !== undefined) {
      operation.maximumSliceBytes = Math.max(operation.maximumSliceBytes, this.#sliceBytes);
    }
    this.#sliceBytes = 0;
  }

  public finishOperation(): void {
    this.#finishSlice();
    this.#currentOperation = "idle";
    this.#inputWasObserved = false;
  }

  public yieldControl = async (): Promise<void> => {
    this.#finishSlice();
    this.yields += 1;
    const operation = this.operations.get(this.#currentOperation);
    if (operation !== undefined) operation.yields += 1;
    if (this.#inputWasObserved) {
      const measurement = this.operations.get(this.#currentOperation);
      if (measurement !== undefined) {
        measurement.inputPauseYields += 1;
        measurement.syntheticInputSamples += 1;
      }
      this.#inputWasObserved = false;
    }
    await this.#wait();
  };
}

interface OperationMeasurement {
  totalBytes: number;
  maximumSliceBytes: number;
  yields: number;
  inputPauseYields: number;
  syntheticInputSamples: number;
}
