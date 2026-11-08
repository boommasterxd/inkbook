// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { createReadingViewPostProcessor } from "../../../../../src/obsidian/embeds/reading-view";
import {
  createMarkdownExportFixture,
  exportDescriptor,
  validatedPreview,
  mountExportTargetScheme,
} from "../../../../fixtures/obsidian/markdown-export";
import { FakePresentationElement } from "../../../../fixtures/obsidian/presentation-dom";
import type { EmbedIntegrationPorts } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import { PORTABLE_PALETTE_V1 } from "../../../../../src/domain/schema/public";
import { ColorSchemeBroadcaster } from "../../../../../src/obsidian/theme/color-scheme";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("awaits every complete saved graphic without mounting an interactive presentation", async () => {
  const descriptor = await validatedPreview();
  const fixture = createMarkdownExportFixture(
    "!inkbook[[../drawings/first.svg|First]]\n\n!inkbook[Second](./second.svg)",
    '<div><p>!inkbook<a href="../drawings/first.svg">First</a></p></div>' +
      '<div><p>!inkbook<a href="./second.svg">Second</a></p></div>',
    descriptor,
  );
  await createReadingViewPostProcessor(fixture.ports)(fixture.root, fixture.context);
  const graphics = fixture.root.querySelectorAll("svg.inkbook-export-definitions");
  expect(graphics).toHaveLength(2);
  const saved = new DOMParser().parseFromString(descriptor.safeSvg, "image/svg+xml");
  for (const graphic of graphics) {
    expect([...graphic.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual(
      [...saved.querySelectorAll("path")].map((path) => path.getAttribute("d")),
    );
    expect(graphic.getAttribute("viewBox")).toBe(saved.documentElement.getAttribute("viewBox"));
    expect(graphic.querySelector("metadata, style, [class]")).toBeNull();
    expect(graphic.querySelector(`path[fill="${PORTABLE_PALETTE_V1.light.page}"]`)).not.toBeNull();
  }
  expect(
    [...fixture.root.querySelectorAll("svg[role='img']")].map((graphic) =>
      graphic.getAttribute("aria-label"),
    ),
  ).toEqual(["First", "Second"]);
  expect(fixture.recognize.mock.calls.map(([id]) => id)).toEqual([
    "drawings/first.svg",
    "notes/second.svg",
  ]);
  expect(fixture.root.querySelector("iframe, button, canvas")).toBeNull();
  expect(fixture.sessions.mount).not.toHaveBeenCalled();
  expect(fixture.cached).not.toHaveBeenCalled();
  expect(fixture.subscribe).not.toHaveBeenCalled();
  fixture.unload();
  expect(fixture.root.querySelectorAll("p > a")).toHaveLength(2);
  expect(fixture.root.querySelector("svg")).toBeNull();
});

it("preserves code, escaped examples, inline text and ordinary native embeds", async () => {
  const fixture = createMarkdownExportFixture(
    [
      "\\!inkbook[[escaped.svg]]",
      "`!inkbook[[inline-code.svg]]`",
      "```md",
      "!inkbook[[fenced.svg]]",
      "```",
      "Before !inkbook[[inline.svg]] after",
      "![[native.svg]]",
      "!inkbook[[valid.svg]]",
    ].join("\n\n"),
    '<p>!inkbook<a href="escaped.svg">escaped.svg</a></p>' +
      "<p><code>!inkbook[[inline-code.svg]]</code></p>" +
      "<pre><code>!inkbook[[fenced.svg]]</code></pre>" +
      '<p>Before !inkbook<a href="inline.svg">inline.svg</a> after</p>' +
      '<p><img src="native.svg"></p>' +
      '<p>!inkbook<a href="valid.svg">valid.svg</a></p>',
  );
  const originals = [...fixture.root.children].slice(0, -1).map((node) => node.outerHTML);
  await createReadingViewPostProcessor(fixture.ports)(fixture.root, fixture.context);
  expect([...fixture.root.children].slice(0, -1).map((node) => node.outerHTML)).toEqual(originals);
  expect(fixture.root.querySelectorAll("p[data-inkbook-export]")).toHaveLength(1);
  expect(fixture.root.querySelector('path[d="M10 5000L30 5020"]')).not.toBeNull();
  expect(fixture.recognize).toHaveBeenCalledExactlyOnceWith("valid.svg", window);
  fixture.unload();
});

it("fails closed for indistinguishable escaped and real blocks but preserves distinct aliases", async () => {
  const fixture = createMarkdownExportFixture(
    "\\!inkbook[[same.svg|Ambiguous]]\n\n!inkbook[[same.svg|Ambiguous]]\n\n!inkbook[[same.svg|Actual]]",
    '<p>!inkbook<a href="same.svg">Ambiguous</a></p>'.repeat(2) +
      '<p>!inkbook<a href="same.svg">Actual</a></p>',
  );
  await createReadingViewPostProcessor(fixture.ports)(fixture.root, fixture.context);
  expect(fixture.root.querySelectorAll("p[data-inkbook-export]")).toHaveLength(1);
  expect(
    fixture.root.lastElementChild?.querySelector("svg[role='img']")?.getAttribute("aria-label"),
  ).toBe("Actual");
  expect(fixture.root.querySelectorAll("a")).toHaveLength(2);
  fixture.unload();
});

it("waits for pending saves and reuses readiness and recognition for repeated files", async () => {
  const fixture = createMarkdownExportFixture(
    "!inkbook[[same.svg|One]]\n\n!inkbook[[same.svg|Two]]",
    '<p>!inkbook<a href="same.svg">One</a></p><p>!inkbook<a href="same.svg">Two</a></p>',
  );
  let ready!: () => void;
  fixture.prepareStaticExport.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  );
  let finished = false;
  const pending = Promise.resolve(
    createReadingViewPostProcessor(fixture.ports)(fixture.root, fixture.context),
  ).then(() => {
    finished = true;
  });
  await vi.waitFor(() => expect(fixture.prepareStaticExport).toHaveBeenCalledOnce());
  expect(finished).toBe(false);
  expect(fixture.recognize).not.toHaveBeenCalled();
  expect(fixture.root.querySelector("svg")).toBeNull();
  ready();
  await pending;
  assertCompleteGraphics(fixture.root);
  expect(fixture.recognize).toHaveBeenCalledOnce();
  await createReadingViewPostProcessor(fixture.ports)(fixture.root, fixture.context);
  assertCompleteGraphics(fixture.root);
  expect(fixture.prepareStaticExport).toHaveBeenCalledOnce();
  expect(fixture.recognize).toHaveBeenCalledOnce();
  fixture.unload();
});

it("prevents publication after the renderer lifecycle unloads during readiness", async () => {
  const fixture = createMarkdownExportFixture(
    "!inkbook[[ink.svg]]",
    '<p>!inkbook<a href="ink.svg">ink.svg</a></p>',
  );
  let ready!: () => void;
  fixture.prepareStaticExport.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  );
  const pending = createReadingViewPostProcessor(fixture.ports)(fixture.root, fixture.context);
  await vi.waitFor(() => expect(fixture.prepareStaticExport).toHaveBeenCalledOnce());
  fixture.unload();
  ready();
  await pending;
  expect(fixture.root.querySelector("svg")).toBeNull();
  expect(fixture.root.querySelector("a")?.getAttribute("href")).toBe("ink.svg");
  expect(fixture.recognize).not.toHaveBeenCalled();
});

it("rejects an export when saving fails instead of silently using stale recognition", async () => {
  const fixture = createMarkdownExportFixture(
    "!inkbook[[ink.svg]]",
    '<p>!inkbook<a href="ink.svg">ink.svg</a></p>',
  );
  fixture.prepareStaticExport.mockRejectedValue(new Error("Save failed."));
  await expect(
    createReadingViewPostProcessor(fixture.ports)(fixture.root, fixture.context),
  ).rejects.toThrow("Save failed.");
  expect(fixture.recognize).not.toHaveBeenCalled();
  expect(fixture.root.querySelector("svg")).toBeNull();
  fixture.unload();
});

it("keeps unrecognized SVG files in the native renderer", async () => {
  const fixture = createMarkdownExportFixture(
    "!inkbook[[ordinary.svg]]",
    '<p>!inkbook<a href="ordinary.svg">ordinary.svg</a></p>',
  );
  fixture.recognize.mockResolvedValue(false);
  const original = fixture.root.innerHTML;
  await createReadingViewPostProcessor(fixture.ports)(fixture.root, fixture.context);
  expect(fixture.root.innerHTML).toBe(original);
  fixture.unload();
});

it("publishes retained definitions in the surviving repeated embed after its first host disappears", async () => {
  const descriptor = exportDescriptor();
  const fixture = createMarkdownExportFixture(
    "!inkbook[[same.svg|One]]\n\n!inkbook[[same.svg|Two]]",
    '<p>!inkbook<a href="same.svg">One</a></p><p>!inkbook<a href="same.svg">Two</a></p>',
    descriptor,
  );
  fixture.recognize.mockImplementation(async () => {
    fixture.root.firstElementChild?.remove();
    return descriptor;
  });
  await createReadingViewPostProcessor(fixture.ports)(fixture.root, fixture.context);
  expect(fixture.root.querySelectorAll("p[data-inkbook-export]")).toHaveLength(1);
  assertCompleteGraphics(fixture.root);
  expect(fixture.recognize).toHaveBeenCalledOnce();
  fixture.unload();
});

it("keeps normal Reading-view presentation mounting independent of static export", async () => {
  const fixture = createMarkdownExportFixture("!inkbook[[ink.svg]]", "");
  const root = new FakePresentationElement();
  const descriptor = {
    aspectRatio: 4,
    contentIdentity: { outputHash: "b".repeat(64), revision: 1 },
    safeSvg: '<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata></svg>',
  };
  const context = {
    ...fixture.context,
    getSectionInfo: () => ({ lineStart: 0, lineEnd: 0, text: "!inkbook[[ink.svg]]" }),
  };
  await createReadingViewPostProcessor({
    ...fixture.ports,
    documents: { ...fixture.ports.documents, cached: () => descriptor },
  })(root as unknown as HTMLElement, context);
  expect(fixture.sessions.mount).toHaveBeenCalledOnce();
  expect(root.children[0]?.classNames).toContain("inkbook-root");
  expect(fixture.readMarkdownSource).not.toHaveBeenCalled();
  expect(fixture.prepareStaticExport).not.toHaveBeenCalled();
  expect(fixture.recognize).not.toHaveBeenCalled();
  fixture.unload();
  expect(root.children).toEqual([]);
});

it("correlates formatted labels and entities while normalizing each repeated label once", async () => {
  const fixture = createMarkdownExportFixture(
    [
      "!inkbook[**Diagram**](ink.svg)",
      "!inkbook[**Diagram**](other.svg)",
      "!inkbook[A &amp; B](ink.svg)",
      "!inkbook[A &amp; B](other.svg)",
    ].join("\n\n"),
    '<p>!inkbook<a href="ink.svg"><strong>Diagram</strong></a></p>' +
      '<p>!inkbook<a href="other.svg"><strong>Diagram</strong></a></p>' +
      '<p>!inkbook<a href="ink.svg">A &amp; B</a></p>' +
      '<p>!inkbook<a href="other.svg">A &amp; B</a></p>',
  );
  const renderExportLabel = await renderFormattedExport(fixture);
  expect(fixture.root.querySelectorAll("p[data-inkbook-export]")).toHaveLength(4);
  expect(
    [...fixture.root.querySelectorAll("svg[role='img']")].map((graphic) =>
      graphic.getAttribute("aria-label"),
    ),
  ).toEqual(["Diagram", "Diagram", "A & B", "A & B"]);
  expect(
    [...fixture.root.querySelectorAll("svg[role='img'] > text")].map((text) => text.textContent),
  ).toEqual(["Diagram", "Diagram", "A & B", "A & B"]);
  expect(renderExportLabel.mock.calls.map(([label]) => label)).toEqual([
    "**Diagram**",
    "A &amp; B",
  ]);
  expect(fixture.recognize.mock.calls.map(([id]) => id)).toEqual(["ink.svg", "other.svg"]);
  fixture.unload();
});

it("plans repeated drawings with the page room left by intervening export fragments", async () => {
  const descriptor = await validatedPreview();
  const fixture = createMarkdownExportFixture(
    "!inkbook[[a.svg|A]]\n\n!inkbook[[b.svg|B]]\n\n!inkbook[[a.svg|A]]",
    '<p>!inkbook<a href="a.svg">A</a></p>' +
      '<p>!inkbook<a href="b.svg">B</a></p>' +
      '<p>!inkbook<a href="a.svg">A</a></p>',
    descriptor,
  );
  document.body.append(fixture.root);
  const media = window.matchMedia("print");
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  await createReadingViewPostProcessor(fixture.ports)(fixture.root, fixture.context);
  const containers = [...fixture.root.querySelectorAll<HTMLElement>("p > .inkbook-static-export")];
  expect(containers).toHaveLength(3);
  const [first, intervening, repeated] = containers;
  const height = Number(first!.querySelector("svg[role='img']")!.getAttribute("height"));
  const rectangles = Array.from({ length: 20 }, (_, index) =>
    DOMRect.fromRect({ y: index * 1000, width: 2048.6, height: 1000 }),
  );
  vi.spyOn(fixture.root, "getClientRects").mockReturnValue(
    Object.assign(rectangles, { item: (index: number) => rectangles[index] ?? null }),
  );
  // Native layout moves the later occurrence when the intervening drawing gains print chrome.
  for (const [index, container] of containers.entries()) {
    vi.spyOn(container, "getBoundingClientRect").mockImplementation(() => {
      const top =
        index === 2
          ? intervening!.dataset.inkbookPagination === "split"
            ? 11_500
            : 10_800
          : index * 800;
      return DOMRect.fromRect({ y: top, width: 2048.6, height });
    });
    vi.spyOn(
      container.querySelector<HTMLElement>(".inkbook-export-pages")!,
      "getBoundingClientRect",
    ).mockReturnValue(DOMRect.fromRect({ width: 2048.6, height }));
  }
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    borderTopLeftRadius: "10px",
  } as CSSStyleDeclaration);
  try {
    media.dispatchEvent(new MediaQueryListEvent("change", { matches: true, media: "print" }));
    expect(intervening!.dataset.inkbookPagination).toBe("split");
    const pieces = repeated!.querySelectorAll<HTMLElement>(".inkbook-export-piece");
    expect(pieces.length).toBeGreaterThan(1);
    expect(Number(pieces[0]!.dataset.inkbookRangeEnd)).toBeGreaterThan(200);
    expect(Number(pieces[0]!.dataset.inkbookRangeEnd)).toBeLessThanOrEqual(477);
    let end = 0;
    for (const piece of pieces) {
      expect(Number(piece.dataset.inkbookRangeStart)).toBe(end);
      end = Number(piece.dataset.inkbookRangeEnd);
    }
    expect(end).toBe(height);
    expect(fixture.recognize.mock.calls.map(([id]) => id)).toEqual(["a.svg", "b.svg"]);
  } finally {
    fixture.unload();
  }
});

it("preserves ambiguous escaped formatted labels after normalization", async () => {
  const fixture = createMarkdownExportFixture(
    "\\!inkbook[**Diagram**](ink.svg)\n\n!inkbook[**Diagram**](ink.svg)",
    '<p>!inkbook<a href="ink.svg"><strong>Diagram</strong></a></p>'.repeat(2),
  );
  const original = fixture.root.innerHTML;
  const renderExportLabel = await renderFormattedExport(fixture);
  expect(fixture.root.innerHTML).toBe(original);
  expect(fixture.recognize).not.toHaveBeenCalled();
  expect(renderExportLabel).toHaveBeenCalledOnce();
  fixture.unload();
});

it("does not confuse genuine formatted ink with an escaped literal label signature", async () => {
  const fixture = createMarkdownExportFixture(
    "!inkbook[**Diagram**](drawing.svg)\n\n\\!inkbook[\\*\\*Diagram\\*\\*](drawing.svg)",
    '<p>!inkbook<a href="drawing.svg"><strong>Diagram</strong></a></p>' +
      '<p>!inkbook<a href="drawing.svg">**Diagram**</a></p>',
  );
  const genuine = fixture.root.firstElementChild;
  const escaped = fixture.root.lastElementChild;
  const literal = escaped?.outerHTML;
  const renderExportLabel = await renderFormattedExport(fixture);
  expect(genuine?.querySelector("svg[role='img']")).not.toBeNull();
  expect(escaped?.outerHTML).toBe(literal);
  expect(fixture.root.querySelectorAll("p[data-inkbook-export]")).toHaveLength(1);
  expect(renderExportLabel.mock.calls.map(([label]) => label)).toEqual(["**Diagram**"]);
  fixture.unload();
});

it("exports the current descriptor without consulting stale recognition or its cache", async () => {
  const fixture = createMarkdownExportFixture(
    "!inkbook[[ink.svg]]",
    '<p>!inkbook<a href="ink.svg">ink.svg</a></p>',
  );
  const current = exportDescriptor('<path d="M40 5100L80 5120" stroke="#102030FF"/>');
  const recognizeCurrent = vi.fn<
    NonNullable<EmbedIntegrationPorts["documents"]["recognizeCurrent"]>
  >(async () => current);
  await createReadingViewPostProcessor({
    ...fixture.ports,
    documents: { ...fixture.ports.documents, recognizeCurrent },
  })(fixture.root, fixture.context);
  expect(recognizeCurrent).toHaveBeenCalledExactlyOnceWith("ink.svg", window);
  expect(fixture.recognize).not.toHaveBeenCalled();
  expect(fixture.cached).not.toHaveBeenCalled();
  expect(fixture.root.querySelector('path[d="M40 5100L80 5120"]')).not.toBeNull();
  expect(fixture.root.querySelector('path[d="M10 5000L30 5020"]')).toBeNull();
  fixture.unload();
});

it("rejects a current-recognition failure without falling back to stale graphics", async () => {
  const fixture = createMarkdownExportFixture(
    "!inkbook[[ink.svg]]",
    '<p>!inkbook<a href="ink.svg">ink.svg</a></p>',
  );
  const original = fixture.root.innerHTML;
  const recognizeCurrent = vi
    .fn<NonNullable<EmbedIntegrationPorts["documents"]["recognizeCurrent"]>>()
    .mockRejectedValue(new Error("Current SVG read failed."));
  await expect(
    createReadingViewPostProcessor({
      ...fixture.ports,
      documents: { ...fixture.ports.documents, recognizeCurrent },
    })(fixture.root, fixture.context),
  ).rejects.toThrow("Current SVG read failed.");
  expect(fixture.recognize).not.toHaveBeenCalled();
  expect(fixture.cached).not.toHaveBeenCalled();
  expect(fixture.root.innerHTML).toBe(original);
  fixture.unload();
});

it("preserves literal Wiki percent paths while resolving encoded Markdown paths", async () => {
  const fixture = createMarkdownExportFixture(
    "!inkbook[[My%20page.svg|Wiki]]\n\n!inkbook[Markdown](Other%20page.svg)",
    '<p>!inkbook<a href="My%20page.svg">Wiki</a></p>' +
      '<p>!inkbook<a href="Other%20page.svg">Markdown</a></p>',
  );
  await createReadingViewPostProcessor(fixture.ports)(fixture.root, fixture.context);
  expect(fixture.recognize.mock.calls.map(([id]) => id)).toEqual([
    "My%20page.svg",
    "Other page.svg",
  ]);
  expect(fixture.root.querySelectorAll("p[data-inkbook-export]")).toHaveLength(2);
  expect(fixture.root.querySelectorAll("defs path")).toHaveLength(2);
  expect(
    [...fixture.root.querySelectorAll("p")].map((host) =>
      host.querySelector("svg[role='img']")?.getAttribute("aria-label"),
    ),
  ).toEqual(["Wiki", "Markdown"]);
  fixture.unload();
});

async function renderFormattedExport(fixture: ReturnType<typeof createMarkdownExportFixture>) {
  const renderExportLabel = vi.fn<NonNullable<EmbedIntegrationPorts["renderExportLabel"]>>(
    async (label, target, owner) => {
      expect(owner).toBe(fixture.children[0]);
      target.textContent = label === "**Diagram**" ? "Diagram" : "A & B";
    },
  );
  await createReadingViewPostProcessor({ ...fixture.ports, renderExportLabel })(
    fixture.root,
    fixture.context,
  );
  return renderExportLabel;
}

it.each(["light", "dark"] as const)(
  "uses the %s export target rather than the opposite source theme",
  async (scheme) => {
    const fixture = createMarkdownExportFixture(
      "!inkbook[[drawing.svg]]",
      '<p>!inkbook<a href="drawing.svg">drawing.svg</a></p>',
      await validatedPreview(),
    );
    mountExportTargetScheme(fixture.root, scheme);
    const source = new ColorSchemeBroadcaster({
      getColorScheme: () => (scheme === "light" ? "dark" : "light"),
    });
    await createReadingViewPostProcessor({ ...fixture.ports, scheme: source })(
      fixture.root,
      fixture.context,
    );
    expect(
      fixture.root.querySelector(".inkbook-static-export")?.getAttribute("data-inkbook-scheme"),
    ).toBe(scheme);
    expect(
      fixture.root.querySelector(`defs path[fill="${PORTABLE_PALETTE_V1[scheme].page}"]`),
    ).not.toBeNull();
    expect(
      fixture.root.querySelector(`defs path[stroke="${PORTABLE_PALETTE_V1[scheme].text}"]`),
    ).not.toBeNull();
    fixture.unload();
  },
);

function assertCompleteGraphics(root: HTMLElement): void {
  expect(root.querySelectorAll("defs")).toHaveLength(1);
  expect(root.querySelectorAll("path")).toHaveLength(1);
  const drawing = root.querySelector("defs > g");
  expect(drawing?.id).toBeTruthy();
  const exports = root.querySelectorAll("p > .inkbook-static-export");
  expect(exports.length).toBeGreaterThan(0);
  for (const container of exports) {
    expect(container.getAttribute("data-inkbook-state")).toBe("locked");
    expect(container.getAttribute("data-inkbook-scheme")).toBe("light");
    const media = container.querySelector<HTMLElement>(
      ".inkbook-locked-preview > .inkbook-export-pages",
    );
    expect(media).not.toBeNull();
    expect(media?.style.getPropertyValue("--inkbook-preview-aspect-ratio")).toBe(
      String(2048.6 / 5200),
    );
    const graphics = media!.querySelectorAll("svg[role='img']");
    expect(graphics).toHaveLength(1);
    expect(graphics[0]?.getAttribute("viewBox")).toBe("0 0 2048.6 5200");
    expect(graphics[0]?.querySelector("use")?.getAttribute("href")).toBe(`#${drawing!.id}`);
  }
}
