// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLivePreviewExtension } from "../../../../src/obsidian/embeds/live-preview";
import type { EmbedIntegrationPorts } from "../../../../src/obsidian/embeds/presentation-port";
import { configureTestEditorState } from "../../../adapters/obsidian/plugin";

const SAFE_PREVIEW_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata></svg>';
const CONTENT_IDENTITY = { outputHash: "a".repeat(64), revision: 1 };

interface RecognitionControl {
  notify: ((documentId: string) => void) | undefined;
  value:
    | false
    | {
        readonly aspectRatio: number;
        readonly contentIdentity: typeof CONTENT_IDENTITY;
        readonly safeSvg: string;
      }
    | undefined;
}

function integrationPorts(control?: RecognitionControl): EmbedIntegrationPorts {
  return {
    documents: {
      cached: () =>
        control?.value ?? {
          aspectRatio: 4,
          contentIdentity: CONTENT_IDENTITY,
          safeSvg: SAFE_PREVIEW_SVG,
        },
      recognize: async () => ({
        aspectRatio: 4,
        contentIdentity: CONTENT_IDENTITY,
        safeSvg: SAFE_PREVIEW_SVG,
      }),
      subscribe: (listener: (documentId: string) => void) => {
        if (control !== undefined) control.notify = listener;
        return () => {
          if (control !== undefined) control.notify = undefined;
        };
      },
    },
    lifecycle: { dispose: () => undefined, register: () => () => undefined },
    resolveDocument: () => ({
      documentId: "drawings/page.svg",
      resourceUrl: "app://vault/drawings/page.svg",
    }),
    scheme: { subscribe: () => () => undefined },
    sessions: {
      activate: () => undefined,
      detach: () => undefined,
      mount: () => undefined,
    },
  } as unknown as EmbedIntegrationPorts;
}

describe("Live Preview block-decoration source", () => {
  beforeEach(() => installObsidianDomHelpers());

  afterEach(() => removeObsidianDomHelpers());

  it("provides layout-changing replacements directly from editor state", () => {
    configureTestEditorState({
      file: { path: "notes/note.md" },
      livePreview: true,
    });
    const state = EditorState.create({
      doc: "!inkbook[[drawings/page.svg]]",
      extensions: [
        editorInfoField,
        editorLivePreviewField,
        createLivePreviewExtension(integrationPorts()),
      ],
    });

    const sources = state.facet(EditorView.decorations);
    expect(sources).toHaveLength(1);
    expect(typeof sources[0]).not.toBe("function");
    let replacement: { readonly from: number; readonly to: number } | undefined;
    (sources[0] as DecorationSet).between(0, state.doc.length, (from, to) => {
      replacement = { from, to };
    });
    expect(replacement).toEqual({ from: 0, to: state.doc.length });
  });

  it("retains the mounted block while a saved SVG is being reclassified", () => {
    const control: RecognitionControl = {
      notify: undefined,
      value: {
        aspectRatio: 4,
        contentIdentity: CONTENT_IDENTITY,
        safeSvg: SAFE_PREVIEW_SVG,
      },
    };
    configureTestEditorState({
      file: { path: "notes/note.md" },
      livePreview: true,
    });
    const parent = document.body.createDiv();
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "!inkbook[[drawings/page.svg]]",
        extensions: [
          editorInfoField,
          editorLivePreviewField,
          createLivePreviewExtension(integrationPorts(control)),
        ],
      }),
    });
    const mounted = parent.querySelector(".inkbook-root");
    expect(mounted).not.toBeNull();

    control.value = undefined;
    control.notify?.("drawings/page.svg");

    expect(parent.querySelector(".inkbook-root")).toBe(mounted);

    control.value = false;
    control.notify?.("drawings/page.svg");

    expect(parent.querySelector(".inkbook-root")).toBeNull();
    view.destroy();
    parent.remove();
  });
});

function installObsidianDomHelpers(): void {
  Object.defineProperties(HTMLElement.prototype, {
    createDiv: {
      configurable: true,
      value(this: HTMLElement, options?: { readonly cls?: string }) {
        const element = createOwnedElement(this, "div");
        if (options?.cls !== undefined) element.className = options.cls;
        this.append(element);
        return element;
      },
    },
    createEl: {
      configurable: true,
      value(
        this: HTMLElement,
        tag: string,
        options?: { readonly attr?: Record<string, string>; readonly cls?: string },
      ) {
        const element = createOwnedElement(this, tag);
        if (options?.cls !== undefined) element.className = options.cls;
        for (const [name, value] of Object.entries(options?.attr ?? {})) {
          element.setAttribute(name, value);
        }
        this.append(element);
        return element;
      },
    },
    setCssProps: {
      configurable: true,
      value(this: HTMLElement, properties: Record<string, string>) {
        for (const [name, value] of Object.entries(properties)) this.style.setProperty(name, value);
      },
    },
  });
}

function createOwnedElement(owner: HTMLElement, tag: string): HTMLElement {
  const factory = Reflect.get(owner.ownerDocument, "createElement");
  return Reflect.apply(factory, owner.ownerDocument, [tag]);
}

function removeObsidianDomHelpers(): void {
  Reflect.deleteProperty(HTMLElement.prototype, "createDiv");
  Reflect.deleteProperty(HTMLElement.prototype, "createEl");
  Reflect.deleteProperty(HTMLElement.prototype, "setCssProps");
  document.body.replaceChildren();
}
