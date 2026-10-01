import type { IncrementalDocumentSerializer } from "../../serialization/incremental-document-serializer";
import { assertScenePathIds, MAX_SCENE_PATH_BYTES, scenePathBytes } from "./scene-path-limits";
import type { PrepareScenePathsRuntimeRequest, PreparedScenePathsRuntimeSuccess } from "./types";
import type { RuntimeWireSliceOptions } from "./element-wire-codec";
import type { SvgPathPart } from "../../../domain/geometry/svg-path-part";

export async function prepareScenePaths(
  request: PrepareScenePathsRuntimeRequest,
  context: { readonly signal: AbortSignal; checkpoint(): Promise<void> | undefined },
  serializer: IncrementalDocumentSerializer,
  assertRevision: () => void,
): Promise<PreparedScenePathsRuntimeSuccess["paths"]> {
  assertScenePathIds(request.ids);
  assertRevision();
  const paths: { id: string; parts: readonly SvgPathPart[] }[] = [];
  let bytes = 0;
  for (const id of request.ids) {
    context.signal.throwIfAborted();
    assertRevision();
    const parts = await serializer.prepareScenePath(id, context);
    if (parts === undefined) continue;
    const nextBytes = scenePathBytes(id, parts);
    if (bytes + nextBytes > MAX_SCENE_PATH_BYTES) continue;
    bytes += nextBytes;
    paths.push({ id, parts });
  }
  return paths;
}

export async function validatePreparedScenePaths(
  request: PrepareScenePathsRuntimeRequest,
  result: PreparedScenePathsRuntimeSuccess,
  options: RuntimeWireSliceOptions,
): Promise<void> {
  options.signal.throwIfAborted();
  assertScenePathIds(request.ids);
  if (result.basisRevision !== request.basisRevision || !Array.isArray(result.paths))
    throw new TypeError("Prepared scene paths do not match the requested model revision.");
  const paths = result.paths as PreparedScenePathsRuntimeSuccess["paths"];
  assertScenePathIds(paths.map(({ id }) => id));
  let bytes = 0;
  let previousIndex = -1;
  for (const path of paths) {
    options.signal.throwIfAborted();
    const index = request.ids.indexOf(path.id);
    if (index <= previousIndex || !Array.isArray(path.parts) || path.parts.length !== 1)
      throw new TypeError("Prepared scene paths do not match the requested visible IDs.");
    previousIndex = index;
    const part = (path.parts as readonly SvgPathPart[])[0];
    if (
      part === null ||
      part === undefined ||
      typeof part !== "object" ||
      typeof part.d !== "string" ||
      (part.paint !== "fill" && part.paint !== "stroke")
    )
      throw new TypeError("Prepared scene path exceeds the internal geometry contract.");
    bytes += scenePathBytes(path.id, path.parts);
    if (bytes > MAX_SCENE_PATH_BYTES || !/^[MLQAZmlqazhv0-9., e+-]*$/u.test(part.d))
      throw new TypeError("Prepared scene contour exceeds the internal transport contract.");
    const pending = options.checkpoint();
    if (pending !== undefined) await pending;
    options.signal.throwIfAborted();
  }
}
