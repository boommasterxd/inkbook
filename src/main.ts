import { Plugin } from "obsidian";

import { PhaseZeroRuntime } from "./adapters/obsidian/phase-zero-runtime";
import {
  createStartupPerformanceMarks,
  markModuleEvaluated,
  type StartupPerformanceMarks,
} from "./adapters/obsidian/startup-performance-marks";

markModuleEvaluated();

export default class InkbookPlugin extends Plugin {
  #runtime: PhaseZeroRuntime | undefined;
  #startupMarks: StartupPerformanceMarks | undefined;

  public override onload(): Promise<void> {
    const startupMarks = createStartupPerformanceMarks();
    this.#startupMarks = startupMarks;
    startupMarks.markOnloadEntered();
    const runtime = new PhaseZeroRuntime(this, undefined, startupMarks);
    this.#runtime = runtime;
    try {
      runtime.register();
    } catch (error: unknown) {
      startupMarks.markOnloadSettled();
      throw error;
    }
    return Promise.resolve().then(() => startupMarks.markOnloadSettled());
  }

  public override onunload(): void {
    const runtime = this.#runtime;
    if (runtime === undefined) return;
    const startupMarks = this.#startupMarks;
    startupMarks?.markOnunloadEntered();
    runtime.dispose();
    this.#runtime = undefined;
    if (startupMarks !== undefined) {
      const markDisposalSettled = (): void =>
        startupMarks.markDisposalSettled({
          resourceCoordinator: runtime.resourceSnapshot(),
        });
      void runtime.settle().then(markDisposalSettled, markDisposalSettled);
    }
  }
}
