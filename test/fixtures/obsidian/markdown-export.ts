import { vi } from "vitest";
import type { MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import type { EmbedIntegrationPorts } from "../../../src/obsidian/embeds/presentation/presentation-port";
import { PresentationLifecycleRegistry } from "../../../src/obsidian/embeds/presentation/presentation-lifecycle-registry";
import {
  inspectPreviewSvg,
  type LoadedPreviewSvg,
} from "../../../src/obsidian/embeds/preview/safe-preview-svg";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { createAllElementSnapshot } from "../../unit/persistence/serialization/fixtures";
import { ColorSchemeBroadcaster } from "../../../src/obsidian/theme/color-scheme";
import { immediateWorkScheduler } from "./immediate-work-scheduler";
import { createReadingViewPostProcessor } from "../../../src/obsidian/embeds/reading-view";

/** A real target CSS context, independent of the source editor's theme. */
export function mountExportTargetScheme(
  root: HTMLElement,
  scheme: "light" | "dark" | "light dark",
): void {
  const stylesheet = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
  stylesheet.textContent = `.inkbook-export-target-fixture { color-scheme: ${scheme}; }`;
  root.classList.add("inkbook-export-target-fixture");
  root.append(stylesheet);
  document.body.append(root);
}

/** Complete saved and independently validated geometry shared by export contracts. */
export async function validatedPreview(): Promise<LoadedPreviewSvg> {
  const serialized = serializeInkbookDocument(createAllElementSnapshot());
  if (!serialized.ok) throw new Error(serialized.error.message);
  const descriptor = await inspectPreviewSvg(serialized.value.svg, {
    workScheduler: immediateWorkScheduler(),
  });
  if (descriptor === null) throw new Error("Expected a validated export fixture.");
  return descriptor;
}

/** A recognized document boundary fixture, including ink below the initial viewport. */
export function exportDescriptor(
  paths = '<path d="M10 5000L30 5020" stroke="#102030FF"/>',
): LoadedPreviewSvg {
  return {
    aspectRatio: 0.4,
    contentIdentity: { outputHash: "a".repeat(64), revision: 7 },
    safeSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048.6 5200"><metadata></metadata><g>${paths}</g></svg>`,
  };
}

/** Models the sectionless full-note HTML supplied by Obsidian's Markdown renderer. */
export function createMarkdownExportFixture(
  source: string,
  html: string,
  descriptor = exportDescriptor(),
) {
  const rendered = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const container = rendered.body.firstElementChild;
  if (container === null) throw new Error("Missing Markdown renderer fixture.");
  const root = document.importNode(container, true) as HTMLElement;
  const children: MarkdownRenderChild[] = [];
  const recognize = vi.fn<EmbedIntegrationPorts["documents"]["recognize"]>(async () => descriptor);
  const readMarkdownSource = vi.fn(async () => source as string | undefined);
  const prepareStaticExport = vi.fn<NonNullable<EmbedIntegrationPorts["prepareStaticExport"]>>(
    async () => {},
  );
  const sessions = { activate: vi.fn(), detach: vi.fn(), mount: vi.fn() };
  const cached = vi.fn(() => false as const);
  const subscribe = vi.fn(() => () => undefined);
  const resolveDocument = vi.fn((linkpath: string, sourcePath: string) => {
    if (!linkpath.endsWith(".svg")) return undefined;
    const documentId = linkpath.startsWith("../")
      ? linkpath.slice(3)
      : linkpath.startsWith("./")
        ? `${sourcePath.slice(0, sourcePath.lastIndexOf("/"))}/${linkpath.slice(2)}`
        : linkpath;
    return { documentId, resourceUrl: `app://vault/${documentId}` };
  });
  const ports: EmbedIntegrationPorts = {
    documents: {
      cached,
      recognize,
      subscribe,
    },
    lifecycle: new PresentationLifecycleRegistry(),
    prepareStaticExport,
    readMarkdownSource,
    resolveDocument,
    scheme: new ColorSchemeBroadcaster({ getColorScheme: () => "dark" }),
    sessions,
    workScheduler: () => immediateWorkScheduler(),
  };
  const context: MarkdownPostProcessorContext = {
    docId: "export-fixture",
    sourcePath: "notes/note.md",
    frontmatter: null,
    getSectionInfo: () => null,
    addChild: (child) => {
      children.push(child);
      child.load();
    },
  };
  return {
    root,
    cached,
    subscribe,
    ports,
    context,
    children,
    recognize,
    readMarkdownSource,
    prepareStaticExport,
    resolveDocument,
    sessions,
    unload: () => {
      for (const child of children) child.unload();
    },
  };
}

/** Exercises the current-file export boundary independently of stale preview recognition. */
export function startCurrentMarkdownExport(
  fixture: ReturnType<typeof createMarkdownExportFixture>,
  descriptor: LoadedPreviewSvg,
) {
  const recognizeCurrent = vi.fn<
    NonNullable<EmbedIntegrationPorts["documents"]["recognizeCurrent"]>
  >(async () => descriptor);
  const pending = createReadingViewPostProcessor({
    ...fixture.ports,
    documents: { ...fixture.ports.documents, recognizeCurrent },
  })(fixture.root, fixture.context);
  return { recognizeCurrent, pending };
}
