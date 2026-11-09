// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { createReadingViewPostProcessor } from "../../../../../src/obsidian/embeds/reading-view";
import {
  createMarkdownExportFixture,
  exportDescriptor,
  startCurrentMarkdownExport,
} from "../../../../fixtures/obsidian/markdown-export";
import type { EmbedIntegrationPorts } from "../../../../../src/obsidian/embeds/presentation/presentation-port";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function currentExportLabels(fixture: ReturnType<typeof createMarkdownExportFixture>) {
  const current = exportDescriptor('<path d="M40 5100L80 5120" stroke="#102030FF"/>');
  const { recognizeCurrent, pending } = startCurrentMarkdownExport(fixture, current);
  await pending;
  return {
    output: [...fixture.root.querySelectorAll<HTMLElement>(".inkbook-static-export")],
    recognizeCurrent,
  };
}

it("awaits source before collecting the native images published after postprocessor invocation", async () => {
  const fixture = createMarkdownExportFixture("![[ink.svg|Drawing|400]]", "<p><span></span></p>");
  const pending = createReadingViewPostProcessor(fixture.ports)(fixture.root, fixture.context);
  // Native MarkdownRenderer publishes image elements after invoking postprocessors,
  // then awaits their returned promises together with the native image loads.
  const image = document.createElementNS("http://www.w3.org/1999/xhtml", "img");
  image.setAttribute("alt", "Drawing");
  image.setAttribute("width", "400");
  image.setAttribute("src", "app://vault/ink.svg");
  fixture.root.querySelector("span")!.append(image);
  await pending;
  expect(fixture.root.querySelector("svg[role='img']")?.getAttribute("aria-label")).toBe("Drawing");
  expect(fixture.root.querySelector('path[d="M10 5000L30 5020"]')).not.toBeNull();
  fixture.unload();
});

it("exports native Wiki and Markdown descriptions and widths through the shared current-document pipeline", async () => {
  const fixture = createMarkdownExportFixture(
    [
      "![[ink.svg]]",
      "![[ink.svg|Wiki|400]]",
      "![Markdown|320](ink.svg)",
      "![](ink.svg)",
      "!inkbook[[ink.svg|Legacy]]",
    ].join("\n\n"),
    '<p><span><img alt="ink.svg" src="app://vault/ink.svg"></span></p>' +
      '<p><span><img alt="Wiki" width="400" src="app://vault/ink.svg"></span></p>' +
      '<p><img alt="Markdown" width="320" src="app://vault/ink.svg"></p>' +
      '<p><img alt="" src="app://vault/ink.svg"></p>' +
      '<p>!inkbook<a href="ink.svg">Legacy</a></p>',
  );
  const originals = [...fixture.root.children].map((host) => [...host.childNodes]);
  const { output, recognizeCurrent } = await currentExportLabels(fixture);
  expect(output).toHaveLength(4);
  expect(
    output.map((root) => root.querySelector("svg[role='img']")?.getAttribute("aria-label")),
  ).toEqual(["Handwriting", "Wiki", "Markdown", "Handwriting"]);
  expect(output.map((root) => root.querySelector("text")?.textContent)).toEqual([
    "Handwriting",
    "Wiki",
    "Markdown",
    "Handwriting",
  ]);
  expect(output.map((root) => root.style.getPropertyValue("--inkbook-embed-inline-size"))).toEqual([
    "",
    "400px",
    "320px",
    "",
  ]);
  expect(fixture.root.querySelectorAll("defs")).toHaveLength(1);
  expect(fixture.root.querySelector('path[d="M40 5100L80 5120"]')).not.toBeNull();
  expect(fixture.prepareStaticExport).toHaveBeenCalledExactlyOnceWith("ink.svg");
  expect(recognizeCurrent).toHaveBeenCalledExactlyOnceWith("ink.svg", window);
  expect(fixture.recognize).not.toHaveBeenCalled();
  expect(fixture.cached).not.toHaveBeenCalled();
  expect(fixture.sessions.mount).not.toHaveBeenCalled();
  fixture.unload();
  expect([...fixture.root.children].map((host) => [...host.childNodes])).toEqual(originals);
  expect(fixture.root.querySelector("[data-inkbook-export]")).toBeNull();
});

it("waits for the pending native document save before recognizing and exporting the latest ink", async () => {
  const fixture = createMarkdownExportFixture(
    "![[ink.svg]]",
    '<p><img alt="ink.svg" src="app://vault/ink.svg"></p>',
  );
  let release!: () => void;
  fixture.prepareStaticExport.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const current = exportDescriptor('<path d="M40 5100L80 5120" stroke="#102030FF"/>');
  const { recognizeCurrent, pending } = startCurrentMarkdownExport(fixture, current);
  await vi.waitFor(() => expect(fixture.prepareStaticExport).toHaveBeenCalledOnce());
  expect(recognizeCurrent).not.toHaveBeenCalled();
  expect(fixture.root.querySelector("svg")).toBeNull();
  release();
  await pending;
  expect(fixture.root.querySelector('path[d="M40 5100L80 5120"]')).not.toBeNull();
  fixture.unload();
});

it("correlates width-only native labels with their target fallback while retaining empty Markdown alt text", async () => {
  const fixture = createMarkdownExportFixture(
    [
      "![](../native-followup/tall.svg)",
      "![400](../native-followup/tall.svg)",
      "![[../native-followup/tall.svg|400]]",
      "![400](../native-followup/my%20drawing.svg)",
      "![400](<../native-followup/my drawing.svg>)",
    ].join("\n\n"),
    '<p><img src="app://vault/native-followup/tall.svg"></p>' +
      '<p><img alt="../native-followup/tall.svg" width="400" src="app://vault/native-followup/tall.svg"></p>' +
      '<p><img alt="../native-followup/tall.svg" width="400" src="app://vault/native-followup/tall.svg"></p>' +
      '<p><img alt="../native-followup/my drawing.svg" width="400" src="app://vault/native-followup/my drawing.svg"></p>' +
      '<p><img alt="../native-followup/my drawing.svg" width="400" src="app://vault/native-followup/my drawing.svg"></p>',
  );
  const { output, recognizeCurrent } = await currentExportLabels(fixture);
  expect(output).toHaveLength(5);
  expect(output.map((root) => root.style.getPropertyValue("--inkbook-embed-inline-size"))).toEqual([
    "",
    "400px",
    "400px",
    "400px",
    "400px",
  ]);
  expect(
    output.map((root) => root.querySelector("svg[role='img']")?.getAttribute("aria-label")),
  ).toEqual(Array.from({ length: 5 }, () => "Handwriting"));
  expect(fixture.root.querySelectorAll('path[d="M40 5100L80 5120"]')).toHaveLength(2);
  expect(fixture.prepareStaticExport.mock.calls).toEqual([
    ["native-followup/tall.svg"],
    ["native-followup/my drawing.svg"],
  ]);
  expect(recognizeCurrent.mock.calls).toEqual([
    ["native-followup/tall.svg", window],
    ["native-followup/my drawing.svg", window],
  ]);
  expect(fixture.recognize).not.toHaveBeenCalled();
  fixture.unload();
});

it("correlates native Markdown punctuation before permissive HTML character references", async () => {
  const fixture = createMarkdownExportFixture(
    [
      String.raw`![A\*B](ink.svg)`,
      String.raw`![A\&amp;B](ink.svg)`,
      "![&#92;*](ink.svg)",
      "![A&copy](ink.svg)",
      "![A&copyB](ink.svg)",
      "![A&#128;B](ink.svg)",
      "![A&#0;B](ink.svg)",
      String.raw`![A\*B|320](ink.svg)`,
      String.raw`![[ink.svg|A\*B]]`,
    ].join("\n\n"),
    '<p><img alt="A*B" src="app://vault/ink.svg"></p>' +
      '<p><img alt="A&amp;B" src="app://vault/ink.svg"></p>' +
      '<p><img alt="\\*" src="app://vault/ink.svg"></p>' +
      '<p><img alt="A©" src="app://vault/ink.svg"></p>' +
      '<p><img alt="A©B" src="app://vault/ink.svg"></p>' +
      '<p><img alt="A€B" src="app://vault/ink.svg"></p>' +
      '<p><img alt="A�B" src="app://vault/ink.svg"></p>' +
      '<p><img alt="A*B" width="320" src="app://vault/ink.svg"></p>' +
      '<p><img alt="A\\*B" src="app://vault/ink.svg"></p>',
  );
  const labels = new Map([
    [String.raw`A\*B`, "A*B"],
    [String.raw`A\&amp;B`, "A&B"],
    ["&#92;*", String.raw`\*`],
    ["A&copy", "A©"],
    ["A&copyB", "A©B"],
    ["A&#128;B", "A€B"],
    ["A&#0;B", "A�B"],
  ]);
  const parse = vi.spyOn(window.DOMParser.prototype, "parseFromString");
  const renderExportLabel = vi.fn<NonNullable<EmbedIntegrationPorts["renderExportLabel"]>>(
    async (label, target) => {
      target.textContent = labels.get(label) ?? "Unexpected label";
    },
  );
  const { pending, recognizeCurrent } = startCurrentMarkdownExport(
    { ...fixture, ports: { ...fixture.ports, renderExportLabel } },
    exportDescriptor(),
  );
  await pending;
  expect(
    [...fixture.root.querySelectorAll("svg[role='img']")].map((svg) =>
      svg.getAttribute("aria-label"),
    ),
  ).toEqual(["A*B", "A&B", String.raw`\*`, "A©", "A©B", "A€B", "A�B", "A*B", "A*B"]);
  expect(renderExportLabel.mock.calls.map(([label]) => label)).toEqual([...labels.keys()]);
  expect(parse).toHaveBeenCalledTimes(6);
  expect(fixture.prepareStaticExport).toHaveBeenCalledExactlyOnceWith("ink.svg");
  expect(recognizeCurrent).toHaveBeenCalledExactlyOnceWith("ink.svg", window);
  fixture.unload();
});

it("correlates native character references while preserving raw emphasis and normalizes PDF descriptions once", async () => {
  const fixture = createMarkdownExportFixture(
    "![**Diagram** &amp; detail|400](ink.svg)\n\n![**Diagram** &amp; detail|320](ink.svg)",
    '<p><span><img alt="**Diagram** &amp; detail" width="400" src="app://vault/ink.svg"></span></p>' +
      '<p><span><img alt="**Diagram** &amp; detail" width="320" src="app://vault/ink.svg"></span></p>',
  );
  const renderExportLabel = vi.fn<NonNullable<EmbedIntegrationPorts["renderExportLabel"]>>(
    async (_label, target) => {
      target.textContent = "Diagram & detail";
    },
  );
  await createReadingViewPostProcessor({ ...fixture.ports, renderExportLabel })(
    fixture.root,
    fixture.context,
  );
  expect(
    [...fixture.root.querySelectorAll("svg[role='img']")].map((svg) =>
      svg.getAttribute("aria-label"),
    ),
  ).toEqual(["Diagram & detail", "Diagram & detail"]);
  expect(
    [...fixture.root.querySelectorAll("svg[role='img'] > text")].map((text) => text.textContent),
  ).toEqual(["Diagram & detail", "Diagram & detail"]);
  expect(renderExportLabel.mock.calls.map(([label]) => label)).toEqual([
    "**Diagram** &amp; detail",
  ]);
  fixture.unload();
});

it("keeps unsupported native images and ambiguous raw HTML occurrences host-owned", async () => {
  const fixture = createMarkdownExportFixture(
    [
      "![[ink.svg|Duplicate]]",
      '<img alt="Duplicate" src="app://vault/ink.svg">',
      "![[ink.svg#fragment|Fragment]]",
      "![[ink.svg|Size|400x200]]",
      "![Entity&#124;400](ink.svg)",
      String.raw`![Escaped\|400](ink.svg)`,
      "Before ![[ink.svg|Inline]] after",
      "![[ordinary.svg]]",
      "!inkbook[[ordinary.svg]]",
      "```md\n![[code.svg]]\n```",
    ].join("\n\n"),
    '<p><img alt="Duplicate" src="app://vault/ink.svg"></p><p><img alt="Duplicate" src="app://vault/ink.svg"></p>' +
      '<p><img alt="Fragment" src="app://vault/ink.svg#fragment"></p>' +
      '<p><img alt="Size" width="400" height="200" src="app://vault/ink.svg"></p>' +
      '<p><img alt="Entity" width="400" src="app://vault/ink.svg"></p>' +
      '<p><img alt="Escaped" width="400" src="app://vault/ink.svg"></p>' +
      '<p>Before <span><img alt="Inline" src="app://vault/ink.svg"></span> after</p>' +
      '<p><img alt="ordinary.svg" src="app://vault/ordinary.svg"></p>' +
      '<p>!inkbook<a href="ordinary.svg">ordinary.svg</a></p>' +
      '<pre><code><p><img alt="code.svg" src="app://vault/code.svg"></p></code></pre>',
  );
  fixture.recognize.mockResolvedValue(false);
  const original = fixture.root.innerHTML;
  await createReadingViewPostProcessor(fixture.ports)(fixture.root, fixture.context);
  expect(fixture.root.innerHTML).toBe(original);
  expect(fixture.recognize).toHaveBeenCalledExactlyOnceWith("ordinary.svg", window);
  fixture.unload();
});
