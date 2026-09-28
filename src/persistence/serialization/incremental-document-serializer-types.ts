import type { InkElementV1, PageV1 } from "../../domain/schema/public";
import type { ElementValidationDerivation } from "../../domain/schema/public";
import type { ElementFragments, RenderBand } from "./element-fragments";
import type { EncodedByteBudget } from "./encoded-byte-budget";

export interface PreparedDelta {
  readonly changed: ReadonlyMap<string, InkElementV1>;
  readonly derivations: ReadonlyMap<string, ElementValidationDerivation>;
  readonly orders: Record<RenderBand, string[]>;
  readonly removed: ReadonlySet<string>;
  readonly page: PageV1;
}

export interface DocumentSerializationDelta {
  readonly baseModelRevision: number;
  readonly changedElementDerivations?: readonly ElementValidationDerivation[];
  readonly changedElements?: readonly InkElementV1[];
  readonly modelRevision: number;
  readonly orderChanges?: Readonly<Partial<Record<RenderBand, readonly string[]>>>;
  readonly page?: PageV1;
  readonly removedIds?: readonly string[];
}

export interface FragmentSerializerInstrumentation {
  readonly backgroundBuilds: number;
  readonly shapeBuilds: number;
  readonly shapeCacheBytes: number;
  readonly shapeCacheElements: number;
  readonly retiredPointComparisons: number;
  readonly cacheBytes: number;
  readonly cacheElements: number;
  readonly derivedBoundsReuses: number;
  readonly fragmentBuilds: number;
  readonly fragmentHits: number;
  readonly fullValidationRuns: number;
  readonly incrementalValidationRuns: number;
}

export interface ElementAssembly {
  readonly content: string;
  readonly elements: InkElementV1[];
  readonly highlights: string;
  readonly maximumBottom: number | null;
  readonly metadata: string[];
}

export interface FragmentAssembly {
  readonly content: ElementFragments[];
  readonly elements: InkElementV1[];
  readonly highlight: ElementFragments[];
  readonly maximumBottom: number | null;
  readonly metadata: string[];
}

export type Background = { readonly background: string; readonly lockedHeight: number };

export interface SerializationBudgets {
  readonly metadata: EncodedByteBudget;
  readonly output: EncodedByteBudget;
}

export interface PreparedSerialization extends SerializationBudgets {
  readonly background: string;
  readonly lockedHeight: number;
  readonly metadataPrefix: string;
  readonly page: PageV1;
  readonly revision: number;
}
