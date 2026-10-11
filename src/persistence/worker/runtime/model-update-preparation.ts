import type { StrokeSamplesV1 } from "../../../domain/schema/public";
import type { IncrementalDocumentSerializer } from "../../serialization/incremental-document-serializer";
import {
  captureSnapshotInputSteps,
  captureDeltaInputSteps,
} from "../../serialization/serialization-input-preparation";
import { consumeSerializationSteps } from "../../serialization/serialization-model-preparation";
import {
  copyElementsToRuntimeSliced,
  copySnapshotToRuntimeSliced,
  type RuntimeStrokeSamples,
} from "./runtime-elements";
import { RuntimeModelError } from "./runtime-model-error";
import type { DocumentExportRequest, ModelSyncRuntimeRequest, RuntimeSliceContext } from "./types";

type ModelUpdateRequest = DocumentExportRequest | ModelSyncRuntimeRequest;

/** Completed copies stay candidate-local until the model's successful confirmation. */
class CandidatePointCopies extends WeakMap<StrokeSamplesV1, RuntimeStrokeSamples> {
  readonly #pending = new Map<StrokeSamplesV1, RuntimeStrokeSamples>();
  public constructor(readonly current: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>) {
    super();
  }
  public override get(source: StrokeSamplesV1): RuntimeStrokeSamples | undefined {
    return this.#pending.get(source) ?? this.current.get(source);
  }
  public override set(source: StrokeSamplesV1, points: RuntimeStrokeSamples): this {
    this.#pending.set(source, points);
    return this;
  }
  public confirm(): void {
    for (const [source, points] of this.#pending) this.current.set(source, points);
    this.#pending.clear();
  }
  public discard(): void {
    this.#pending.clear();
  }
}

interface ModelUpdatePreparationOptions {
  readonly serializer: IncrementalDocumentSerializer;
  readonly request: ModelUpdateRequest;
  readonly context: RuntimeSliceContext;
  readonly pointCopies: WeakMap<StrokeSamplesV1, RuntimeStrokeSamples>;
  readonly ownsSamples: boolean;
}

export async function prepareModelUpdate(options: ModelUpdatePreparationOptions) {
  const { serializer, context } = options;
  const copies = new CandidatePointCopies(options.pointCopies);
  try {
    context.signal.throwIfAborted();
    const request = await consumeSerializationSteps(
      captureModelUpdateHeaderSteps(options.request),
      context,
    );
    const result =
      "snapshot" in request
        ? await prepareFullUpdate(request, copies, options)
        : await serializer.applyDeltaSliced(
            {
              ...request,
              ...(request.changedElements === undefined
                ? {}
                : {
                    changedElements: await copyElementsToRuntimeSliced(
                      request.changedElements,
                      context,
                      copies,
                      options.ownsSamples,
                    ),
                  }),
            },
            context,
            true,
          );
    return { result, confirm: () => copies.confirm(), discard: () => copies.discard() };
  } catch (error) {
    copies.discard();
    throw error;
  }
}

async function prepareFullUpdate(
  request: Extract<ModelUpdateRequest, { baseModelRevision: null }>,
  copies: CandidatePointCopies,
  options: ModelUpdatePreparationOptions,
) {
  if (request.snapshot.revision !== request.modelRevision)
    throw new RuntimeModelError("revision-mismatch", false);
  const candidate = await copySnapshotToRuntimeSliced(
    request.snapshot,
    options.context,
    copies,
    undefined,
    options.ownsSamples,
  );
  return options.serializer.resetRuntimeSliced(candidate, options.context, true);
}

function* captureModelUpdateHeaderSteps<T extends ModelUpdateRequest>(
  source: T,
): Generator<void, T> {
  const request = { ...source };
  if ("snapshot" in request) {
    return { ...request, snapshot: yield* captureSnapshotInputSteps(request.snapshot) };
  }
  return (yield* captureDeltaInputSteps(request)) as T;
}
