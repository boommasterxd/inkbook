// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { createReadingViewPostProcessor } from "../../../../../src/obsidian/embeds/reading-view";
import {
  createMarkdownExportFixture,
  exportDescriptor,
  startCurrentMarkdownExport,
} from "../../../../fixtures/obsidian/markdown-export";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
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
