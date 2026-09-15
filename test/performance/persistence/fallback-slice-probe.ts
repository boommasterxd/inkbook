declare const process: {
  threadCpuUsage: () => { readonly system: number; readonly user: number };
};
declare function setImmediate(callback: () => void): void;

export class FallbackSliceProbe {
  readonly durations: number[] = [];
  readonly operations = new Map<string, OperationMeasurement>();
  #currentOperation = "idle";
  #inputQueryPhase = 0;
  #inputWasObserved = false;
  #sliceStarted = readThreadCpuMilliseconds();

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
      durations: [],
      inputPauseYields: 0,
      syntheticInputSamples: 0,
    });
    this.#inputQueryPhase = 0;
    this.#inputWasObserved = false;
    this.#sliceStarted = readThreadCpuMilliseconds();
  }

  public finishOperation(): void {
    this.#recordSlice();
    this.#currentOperation = "idle";
    this.#inputWasObserved = false;
  }

  public yieldControl = async (): Promise<void> => {
    this.#recordSlice();
    if (this.#inputWasObserved) {
      const measurement = this.operations.get(this.#currentOperation);
      if (measurement !== undefined) {
        measurement.inputPauseYields += 1;
        measurement.syntheticInputSamples += 1;
      }
      this.#inputWasObserved = false;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.#sliceStarted = readThreadCpuMilliseconds();
  };

  #recordSlice(): void {
    const duration = readThreadCpuMilliseconds() - this.#sliceStarted;
    this.durations.push(duration);
    this.operations.get(this.#currentOperation)?.durations.push(duration);
  }
}

interface OperationMeasurement {
  readonly durations: number[];
  inputPauseYields: number;
  syntheticInputSamples: number;
}

function readThreadCpuMilliseconds(): number {
  const usage = process.threadCpuUsage();
  return (usage.system + usage.user) / 1_000;
}
