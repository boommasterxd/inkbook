import type { IncrementalDocumentSerializer } from "../../serialization/incremental-document-serializer";
import { assertScenePathIds, MAX_SCENE_PATH_BYTES, scenePathBytes } from "./scene-path-limits";
import type { PrepareScenePathsRuntimeRequest, PreparedScenePathsRuntimeSuccess } from "./types";
import type { RuntimeWireSliceOptions } from "./element-wire-codec";

export async function prepareScenePaths(
  request: PrepareScenePathsRuntimeRequest,
  context: { readonly signal: AbortSignal; checkpoint(): Promise<void> | undefined },
  serializer: IncrementalDocumentSerializer,
  assertRevision: () => void,
): Promise<PreparedScenePathsRuntimeSuccess["paths"]> {
  assertScenePathIds(request.ids);
  assertRevision();
  const paths: { id: string; d: string }[] = [];
  let bytes = 0;
  for (const id of request.ids) {
    context.signal.throwIfAborted();
    assertRevision();
    const d = await serializer.preparePressurePath(id, context);
    if (d === undefined) continue;
    const nextBytes = scenePathBytes(id, d);
    if (bytes + nextBytes > MAX_SCENE_PATH_BYTES) continue;
    bytes += nextBytes;
    paths.push({ id, d });
  }
  return paths;
}

export async function validatePreparedScenePaths(
  request: PrepareScenePathsRuntimeRequest,
  result: PreparedScenePathsRuntimeSuccess,
  options: RuntimeWireSliceOptions,
): Promise<void> {
  assertScenePathIds(request.ids);
  if (result.basisRevision !== request.basisRevision || !Array.isArray(result.paths))
    throw new TypeError("Prepared scene paths do not match the requested model revision.");
  const paths = result.paths as PreparedScenePathsRuntimeSuccess["paths"];
  assertScenePathIds(paths.map(({ id }) => id));
  let bytes = 0;
  let previousIndex = -1;
  for (const path of paths) {
    const index = request.ids.indexOf(path.id);
    if (index <= previousIndex || typeof path.d !== "string")
      throw new TypeError("Prepared scene paths do not match the requested visible IDs.");
    previousIndex = index;
    bytes += scenePathBytes(path.id, path.d);
    if (bytes > MAX_SCENE_PATH_BYTES || !/^[MLQAZmlqazhv0-9., e+-]*$/u.test(path.d))
      throw new TypeError("Prepared scene contour exceeds the internal transport contract.");
    const pending = options.checkpoint();
    if (pending !== undefined) await pending;
  }
}
