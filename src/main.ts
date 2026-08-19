import { Plugin } from "obsidian";

import { PhaseZeroRuntime } from "./adapters/obsidian/phase-zero-runtime";

export default class InkbookPlugin extends Plugin {
  #runtime: PhaseZeroRuntime | undefined;

  public override onload(): Promise<void> {
    const runtime = new PhaseZeroRuntime(this);
    this.#runtime = runtime;
    runtime.register();
    return Promise.resolve();
  }

  public override onunload(): void {
    this.#runtime?.dispose();
    this.#runtime = undefined;
  }
}
