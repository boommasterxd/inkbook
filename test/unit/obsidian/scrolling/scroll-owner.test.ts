import { describe, expect, it } from "vitest";

import { resolveScrollOwner } from "../../../../src/obsidian/scrolling";
import { createFakePorts, FakeScrollElement } from "./fakes";

describe("resolveScrollOwner", () => {
  it("prefers the first eligible ancestor with a positive scroll range", () => {
    const root = new FakeScrollElement("root");
    const outer = new FakeScrollElement("outer");
    const inner = new FakeScrollElement("inner");
    const embed = new FakeScrollElement("embed");
    embed.parent = inner;
    inner.parent = outer;
    outer.parent = root;
    inner.overflowY = "auto";
    outer.overflowY = "scroll";
    outer.scrollHeight = 300;
    const ports = createFakePorts(root);

    expect(resolveScrollOwner(embed, ports.document, ports.metrics)).toBe(outer);
  });

  it("retains the nearest eligible ancestor for a short note", () => {
    const root = new FakeScrollElement("root");
    const owner = new FakeScrollElement("owner");
    const embed = new FakeScrollElement("embed");
    embed.parent = owner;
    owner.parent = root;
    owner.overflowY = "auto";
    root.overflowY = "scroll";
    const ports = createFakePorts(root);

    expect(resolveScrollOwner(embed, ports.document, ports.metrics)).toBe(owner);
  });

  it("falls back to the owning document scrolling element", () => {
    const documentScroller = new FakeScrollElement("document");
    const parent = new FakeScrollElement("parent");
    const embed = new FakeScrollElement("embed");
    embed.parent = parent;
    const ports = createFakePorts(documentScroller);

    expect(resolveScrollOwner(embed, ports.document, ports.metrics)).toBe(documentScroller);
  });

  it("returns null when neither an eligible ancestor nor fallback exists", () => {
    const embed = new FakeScrollElement("embed");
    const ports = createFakePorts(null);

    expect(resolveScrollOwner(embed, ports.document, ports.metrics)).toBeNull();
  });
});
