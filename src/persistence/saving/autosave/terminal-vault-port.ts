import type { ExistingFilePort, NewFilePort } from "../save-ports";

export function createTerminalVaultPort(
  vault: ExistingFilePort & Partial<NewFilePort>,
  isDisposed: () => boolean,
): ExistingFilePort & Partial<NewFilePort> {
  const whileLive = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    assertLive(isDisposed);
    const value = await operation();
    assertLive(isDisposed);
    return value;
  };
  const create = vault.create;
  const createAndReadBack = vault.createAndReadBack;
  return {
    ...(create === undefined
      ? {}
      : {
          create: (path: string, content: string) =>
            whileLive(() => create.call(vault, path, content)),
        }),
    ...(createAndReadBack === undefined
      ? {}
      : {
          createAndReadBack: (path: string, content: string, maximumBytes: number) =>
            whileLive(() => createAndReadBack.call(vault, path, content, maximumBytes)),
        }),
    process: (path, update) => whileLive(() => vault.process(path, update)),
    readWithMetadataGuard: (path, maximumBytes) =>
      whileLive(() => vault.readWithMetadataGuard(path, maximumBytes)),
  };
}

function assertLive(isDisposed: () => boolean): void {
  if (isDisposed()) throw new Error("The autosave coordinator has been disposed.");
}
