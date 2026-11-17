import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { TextMathResolver } from "../../rendering/text/text-layout-types";
import {
  EmbeddedModuleLoader,
  sanitizeOwnedModuleUrl,
  type EmbeddedModuleImporter,
} from "../runtime/embedded-module-loader";
import { PORTABLE_MATH_GZIP } from "./portable-math-source";

export interface PortableMathEngine extends TextMathResolver {
  dispose(): void;
}

interface PortableMathModule {
  readonly createPortableMathRenderer: (scheduler: WorkScheduler) => PortableMathEngine;
}

/** The DOM-free factory shares its actual import realm, never a requesting document window. */
export class PortableMathModuleLoader {
  readonly #modules: EmbeddedModuleLoader<PortableMathModule>;
  readonly #importRealm: unknown;

  public constructor(
    importModule: EmbeddedModuleImporter = nativeImport,
    importRealm: unknown = typeof window === "undefined" ? undefined : window,
  ) {
    this.#importRealm = importRealm;
    this.#modules = new EmbeddedModuleLoader(
      { source: PORTABLE_MATH_GZIP, label: "portable math", validate: requirePortableMathModule },
      importModule,
    );
  }

  public acquire() {
    return this.#modules.acquire(this.#importRealm);
  }
}

export const portableMathLoader = new PortableMathModuleLoader();

function requirePortableMathModule(value: unknown): PortableMathModule {
  if (
    typeof value !== "object" ||
    value === null ||
    !("createPortableMathRenderer" in value) ||
    typeof value.createPortableMathRenderer !== "function"
  ) {
    throw new Error("The embedded portable math module is invalid.");
  }
  return value as PortableMathModule;
}

async function nativeImport(url: string): Promise<unknown> {
  return import(sanitizeOwnedModuleUrl(url));
}
