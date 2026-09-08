import { describe, expect, it, vi } from "vitest";

import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import type { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { commitPreviewReplacement } from "../../../../../src/obsidian/embeds/active-editor/preview-replacement-commit";
import { rectangle } from "../../../domain/store/fixtures";

describe("preview replacement commit", () => {
  it("arms the renderer handoff before committing history", () => {
    const element = rectangle();
    const replacement = { ...element, x: element.x + 10 };
    const calls: string[] = [];
    const cancel = vi.fn();
    const result = commitPreviewReplacement({
      effect: undefined,
      history: historyPort(() => (calls.push("history"), true)),
      motion: {
        beginPreviewCommit: () => ({
          arm: (ids) => (calls.push(`arm:${ids.join(",")}`), true),
          cancel,
        }),
        suppressMotionForNextDelta: vi.fn(),
      },
      previous: [element],
      replacements: [replacement],
    });

    expect(result).toBe(true);
    expect(calls).toEqual([`arm:${element.id}`, "history"]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels an armed handoff when history rejects the replacement", () => {
    const element = rectangle();
    const cancel = vi.fn();
    const result = commitPreviewReplacement({
      effect: undefined,
      history: historyPort(() => false),
      motion: {
        beginPreviewCommit: () => ({ arm: () => true, cancel }),
        suppressMotionForNextDelta: vi.fn(),
      },
      previous: [element],
      replacements: [element],
    });

    expect(result).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not mutate history when the renderer cannot arm the handoff", () => {
    const element = rectangle();
    const replace = vi.fn(() => true);
    const cancel = vi.fn();
    const result = commitPreviewReplacement({
      effect: undefined,
      history: historyPort(replace),
      motion: {
        beginPreviewCommit: () => ({ arm: () => false, cancel }),
        suppressMotionForNextDelta: vi.fn(),
      },
      previous: [element],
      replacements: [element],
    });

    expect(result).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels the handoff when history throws", () => {
    const element = rectangle();
    const cancel = vi.fn();
    expect(() =>
      commitPreviewReplacement({
        effect: undefined,
        history: historyPort(() => {
          throw new Error("history failed");
        }),
        motion: {
          beginPreviewCommit: () => ({ arm: () => true, cancel }),
          suppressMotionForNextDelta: vi.fn(),
        },
        previous: [element],
        replacements: [element],
      }),
    ).toThrow("history failed");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("falls back to one-delta motion suppression without a handoff", () => {
    const element = rectangle();
    const suppressMotionForNextDelta = vi.fn();
    const result = commitPreviewReplacement({
      effect: undefined,
      history: historyPort(() => true),
      motion: { suppressMotionForNextDelta },
      previous: [element],
      replacements: [element],
    });

    expect(result).toBe(true);
    expect(suppressMotionForNextDelta).toHaveBeenCalledWith([element.id]);
  });
});

function historyPort(
  replace: (previous: readonly InkElementV1[], replacements: readonly InkElementV1[]) => boolean,
): ActiveEditorHistory {
  return { replace } as ActiveEditorHistory;
}
