import { invertedEffects, isolateHistory } from "@codemirror/commands";
import type { Plugin } from "obsidian";

import type { ViewId } from "../../application/host-history";
import {
  createEditorHistoryBridgeV1,
  type EditorHistoryBridgeCallbacksV1,
} from "./editor-history";

interface RuntimeEditorAttachment {
  readonly editorViewId: ViewId;
  readonly ownerViewId: ViewId;
}

export const MAX_ACTIVE_EDITOR_IDENTITIES = 256;

export class EditorIdentityPool {
  readonly #activeIds = new Set<ViewId>();
  #disposed = false;

  public claim(): ViewId | null {
    if (this.#disposed) return null;
    for (let slot = 1; slot <= MAX_ACTIVE_EDITOR_IDENTITIES; slot += 1) {
      const editorViewId = `inkbook-editor-${String(slot)}` as ViewId;
      if (this.#activeIds.has(editorViewId)) continue;
      this.#activeIds.add(editorViewId);
      return editorViewId;
    }
    return null;
  }

  public release(editorViewId: ViewId): void {
    this.#activeIds.delete(editorViewId);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#activeIds.clear();
  }
}

export class PluginRuntime {
  readonly #plugin: Plugin;
  readonly #editorIds = new EditorIdentityPool();
  readonly #callbacks: EditorHistoryBridgeCallbacksV1;
  #disposed = false;
  #registered = false;

  public constructor(plugin: Plugin) {
    this.#plugin = plugin;
    this.#callbacks = {
      attachEditor: (): RuntimeEditorAttachment | null => this.#attachEditor(),
      detachEditor: (editorViewId): void => {
        this.#editorIds.release(editorViewId);
      },
      enqueueDelivery: (): void => undefined,
      reportMalformed: (): void => undefined,
      sequenceHighWater: (): undefined => undefined,
    };
  }

  public register(): void {
    if (this.#registered || this.#disposed) return;
    this.#registered = true;
    const bridge = createEditorHistoryBridgeV1(
      { invertedEffects, isolateHistory },
      this.#callbacks,
    );
    if (bridge.kind !== "available") return;
    this.#plugin.registerEditorExtension(bridge.extension);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#editorIds.dispose();
  }

  #attachEditor(): RuntimeEditorAttachment | null {
    if (this.#disposed) return null;
    const editorViewId = this.#editorIds.claim();
    if (editorViewId === null) return null;
    return { editorViewId, ownerViewId: editorViewId };
  }
}
