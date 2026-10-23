import { describe, expect, it, vi } from "vitest";
import { createBuiltInSettings } from "../../../../../../src/domain/settings/defaults";
import {
  CreationPreview,
  type CreationPreviewRenderer,
} from "../../../../../../src/obsidian/embeds/active-editor/previews/creation-preview";
import { ActiveEditorHistory } from "../../../../../../src/obsidian/embeds/active-editor/history";
import { creationPreviewRenderer } from "../../../../../fixtures/obsidian/active-editor";

const identity = { createdAt: 1, id: "00000000-0000-4000-8000-000000000001" };

describe("straight highlighter commit handoff", () => {
  it.each(["success", "rejected", "throw"] as const)(
    "retains live feedback through history creation and handles %s",
    (outcome) => {
      const events: string[] = [];
      const feedback = {
        setLivePath: vi.fn<CreationPreviewRenderer["setLivePath"]>((path) => {
          if (path === null) events.push("clear");
        }),
        commitLivePath: vi.fn(() => events.push("retain")),
        commitLiveStroke: vi.fn(),
        clearLiveStroke: vi.fn(),
      };
      const renderer = creationPreviewRenderer(feedback);
      const failure = new Error("Commit failed");
      const commitElements = vi.fn(() => {
        events.push("commit");
        expect(feedback.setLivePath).not.toHaveBeenCalledWith(null);
        expect(feedback.commitLivePath).not.toHaveBeenCalled();
        if (outcome === "throw") throw failure;
      });
      const history = new ActiveEditorHistory({
        mutationAvailability: outcome === "rejected" ? "revision-exhausted" : "available",
        commitElements,
        commitBandOrder: vi.fn(),
        commitPage: vi.fn(),
        removeElements: vi.fn(),
        replaceElements: vi.fn(),
      });
      const preview = new CreationPreview({
        defaults: createBuiltInSettings().toolDefaults,
        history,
        identity,
        renderer,
        start: {
          additive: false,
          kind: "tool-gesture",
          pointer: { pointerId: 1, pointerType: "pen", x: 10, y: 20 },
          tool: "straight-highlighter",
        },
      });
      preview.update({ pointerId: 1, pointerType: "pen", x: 110, y: 20 });
      expect(feedback.setLivePath).toHaveBeenLastCalledWith(
        expect.objectContaining({ band: "highlight" }),
      );
      if (outcome === "throw") expect(() => preview.commit()).toThrow(failure);
      else expect(preview.commit()).toBe(outcome === "success");
      if (outcome === "success") {
        expect(events).toEqual(["commit", "retain"]);
        expect(feedback.commitLivePath).toHaveBeenCalledExactlyOnceWith(identity.id);
        expect(history.commandCount).toBe(1);
      } else {
        expect(events).toEqual(outcome === "throw" ? ["commit", "clear"] : ["clear"]);
        expect(feedback.commitLivePath).not.toHaveBeenCalled();
        expect(feedback.setLivePath).toHaveBeenLastCalledWith(null);
        expect(history.commandCount).toBe(0);
      }
      expect(commitElements).toHaveBeenCalledTimes(outcome === "rejected" ? 0 : 1);
      expect(feedback.commitLiveStroke).not.toHaveBeenCalled();
      expect(feedback.clearLiveStroke).not.toHaveBeenCalled();
      const eventCount = events.length;
      preview.revert();
      expect(events).toHaveLength(eventCount);
    },
  );
});
