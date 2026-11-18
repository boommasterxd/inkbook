import { ImageResourceBudget } from "../../domain/images/image-resource-budget";
import type { ImageResourceV3 } from "../../domain/schema/public";
import { ImageImportError } from "./image-import-error";

/** Keeps placements ordered and includes history-retained assets in early capacity checks. */
export class ImageImportStaging {
  #budget: ImageResourceBudget;
  #retained: readonly ImageResourceV3[] | undefined;
  readonly #unique = new Map<string, ImageResourceV3>();
  readonly #resources: ImageResourceV3[] = [];

  public constructor(private readonly readRetained?: () => readonly ImageResourceV3[] | undefined) {
    this.#retained = readRetained?.();
    this.#budget = this.#currentBudget();
  }

  public get resources(): readonly ImageResourceV3[] {
    return this.#resources;
  }

  public add(resource: ImageResourceV3): void {
    const prior = this.#unique.get(resource.id);
    if (prior === undefined) {
      if (!this.#budget.tryInclude(resource)) this.#recheck(resource);
      this.#unique.set(resource.id, resource);
    }
    this.#resources.push(prior ?? resource);
  }

  #recheck(resource: ImageResourceV3): void {
    const current = this.readRetained?.();
    if (current !== this.#retained) {
      this.#retained = current;
      this.#budget = this.#currentBudget();
      if (this.#budget.tryInclude(resource)) return;
    }
    throw capacityError();
  }

  #currentBudget(): ImageResourceBudget {
    const budget = new ImageResourceBudget();
    for (const resource of this.#retained ?? [])
      if (!budget.tryInclude(resource)) throw capacityError();
    for (const resource of this.#unique.values())
      if (!budget.tryInclude(resource)) throw capacityError();
    return budget;
  }
}

function capacityError(): ImageImportError {
  return new ImageImportError("documentCapacity", "Image document capacity exceeded.");
}
