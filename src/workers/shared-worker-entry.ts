import {
  installSharedWorkerRuntime,
  type SharedWorkerScope,
} from "./shared-worker-runtime";

installSharedWorkerRuntime(globalThis as unknown as SharedWorkerScope);
