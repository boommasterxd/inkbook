import type { EmbeddedModuleWindow } from "../../../src/obsidian/runtime/embedded-module-loader";

export interface EmbeddedModuleWindowFixture {
  readonly blobs: Blob[];
  readonly document: Document;
  readonly revoked: string[];
  readonly runTimers: () => void;
  readonly window: EmbeddedModuleWindow;
}

export function createEmbeddedModuleWindow(name: string): EmbeddedModuleWindowFixture {
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const objectUrlApi = Object.assign(function URL() {}, {
    createObjectURL: (blob: Blob) => {
      blobs.push(blob);
      return `blob:${name}`;
    },
    revokeObjectURL: (url: string) => revoked.push(url),
  });
  const window: EmbeddedModuleWindow = {
    Blob,
    clearTimeout: (handle) => timers.delete(handle),
    DecompressionStream,
    Response,
    setTimeout: (callback) => {
      const handle = ++nextTimer;
      timers.set(handle, callback);
      return handle;
    },
    URL: objectUrlApi,
  };
  const document = { defaultView: window } as unknown as Document;
  return {
    blobs,
    document,
    revoked,
    runTimers: () => {
      for (const callback of [...timers.values()]) callback();
    },
    window,
  };
}
