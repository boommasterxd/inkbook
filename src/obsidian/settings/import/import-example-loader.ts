import { EmbeddedModuleLoader, sanitizeOwnedModuleUrl } from "../../runtime/embedded-module-loader";
import type { IMPORT_EXAMPLE_IMAGES } from "./import-example-images";
import { IMPORT_EXAMPLES_GZIP } from "./import-example-source";

interface ImportExampleModule {
  readonly IMPORT_EXAMPLE_IMAGES: typeof IMPORT_EXAMPLE_IMAGES;
}

const loader = new EmbeddedModuleLoader(
  { source: IMPORT_EXAMPLES_GZIP, label: "import examples", validate: requireImportExampleModule },
  async (url) => import(sanitizeOwnedModuleUrl(url)),
);

export function acquireImportExamples(owningWindow: unknown) {
  return loader.acquire(owningWindow);
}

function requireImportExampleModule(value: unknown): ImportExampleModule {
  if (
    typeof value !== "object" ||
    value === null ||
    !("IMPORT_EXAMPLE_IMAGES" in value) ||
    !Array.isArray(value.IMPORT_EXAMPLE_IMAGES)
  ) {
    throw new Error("The embedded import examples module is invalid.");
  }
  return value as ImportExampleModule;
}
