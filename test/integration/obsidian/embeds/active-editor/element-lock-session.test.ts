import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../../../src/domain/store/public";
import { ElementLockSession } from "../../../../../src/obsidian/embeds/active-editor/element-lock-session";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-session/document-model-port";
import { ActiveDocumentHistory } from "../../../../../src/obsidian/embeds/active-editor/document-history";
import {
  elementMutationPorts,
  elementReplacementPorts,
} from "../../../../fixtures/obsidian/element-mutation-ports";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { IDS, PAGE, rectangle, highlighter } from "../../../../unit/domain/store/fixtures";

function harness(finishText?: () => Promise<boolean>) {
  const store = new ElementStore([rectangle(), { ...highlighter(), locked: true }]);
  let revision = 0;
  let selection: ReadonlySet<string> = new Set([IDS.target, IDS.highlight]);
  const model = {
    store,
    page: PAGE,
    mutationAvailability: "available",
    get revision() {
      return revision;
    },
    ...elementMutationPorts(store, () => {
      revision += 1;
    }),
    ...elementReplacementPorts(store, () => {
      revision += 1;
    }),
  } as EditableDocumentModel;
  const history = new ActiveEditorHistory(model);
  const pending = vi.fn();
  const failed = vi.fn();
  const changed = vi.fn();
  const scheduler = immediateWorkScheduler();
  const session = new ElementLockSession({
    model,
    history,
    workScheduler: scheduler,
    currentSelection: () => selection,
    setSelection: (next) => {
      selection = next;
    },
    isEnabled: () => true,
    isAttached: () => true,
    onPendingChanged: pending,
    onStateChanged: changed,
    onFailed: failed,
    ...(finishText === undefined ? {} : { finishText }),
  });
  return {
    store,
    model,
    history,
    pending,
    failed,
    changed,
    session,
    scheduler,
    select: (next: ReadonlySet<string>) => {
      selection = next;
    },
    selection: () => selection,
  };
}

it("locks mixed selections as one command and restores each previous state on undo", async () => {
  const owner = harness();
  const existing = owner.store.get(IDS.highlight);
  expect(owner.session.selectionState).toEqual({ unlocked: 1, locked: 1 });
  owner.session.setLocked(true);
  await vi.waitFor(() => expect(owner.history.commandCount).toBe(1));
  expect(owner.store.get(IDS.target)?.element.locked).toBe(true);
  expect(owner.store.get(IDS.highlight)).toBe(existing);
  expect(await owner.history.undoAsync()).toBe(true);
  expect(owner.store.get(IDS.target)?.element.locked).not.toBe(true);
  expect(owner.store.get(IDS.highlight)?.element.locked).toBe(true);
  expect(await owner.history.redoAsync()).toBe(true);
  expect(owner.session.selectionState).toEqual({ unlocked: 0, locked: 2 });
  expect(owner.failed).not.toHaveBeenCalled();
  owner.session.dispose();
});

it("selects every locked element and unlocks it without changing unselected elements", async () => {
  const owner = harness();
  owner.select(new Set());
  owner.session.selectLocked();
  await vi.waitFor(() => expect(owner.selection()).toEqual(new Set([IDS.highlight])));
  expect(owner.history.commandCount).toBe(0);
  owner.session.setLocked(false);
  await vi.waitFor(() => expect(owner.history.commandCount).toBe(1));
  expect(owner.store.lockedCount).toBe(0);
  expect(owner.store.get(IDS.target)?.element.locked).not.toBe(true);
  expect(await owner.history.undoAsync()).toBe(true);
  expect(owner.store.get(IDS.highlight)?.element.locked).toBe(true);
  owner.session.dispose();
});

it("does not register no-op locks or commands after disposal", async () => {
  const owner = harness();
  owner.select(new Set([IDS.highlight]));
  owner.session.setLocked(true);
  await vi.waitFor(() => expect(owner.pending).toHaveBeenLastCalledWith(false));
  expect(owner.history.commandCount).toBe(0);
  owner.session.dispose();
  owner.session.setLocked(false);
  expect(owner.store.lockedCount).toBe(1);
});

it("removes only editable elements from mixed selections and erase-all preserves locks", async () => {
  const owner = harness();
  const commands = new ActiveDocumentHistory({ model: owner.model, history: owner.history });
  const collected = vi.fn();
  expect(
    await commands.removeSelection(owner.selection(), owner.scheduler, () => true, collected),
  ).toBe("applied");
  expect(collected).toHaveBeenCalledWith([IDS.target]);
  expect(owner.store.get(IDS.highlight)?.element.locked).toBe(true);
  expect(await owner.history.undoAsync()).toBe(true);
  expect(await commands.removeAll(owner.scheduler, () => true)).toBe("applied");
  expect(owner.store.size).toBe(1);
  expect(owner.store.get(IDS.highlight)?.element.locked).toBe(true);
  commands.dispose();
  owner.session.dispose();
});

it("rejects stale lock preparation without a partial change or history entry", async () => {
  const owner = harness();
  const prepare = owner.model.prepareElementReplacement.bind(owner.model);
  owner.model.prepareElementReplacement = async (elements, cancellation) => {
    const prepared = await prepare(elements, cancellation);
    owner.select(new Set([IDS.highlight]));
    return prepared;
  };
  owner.session.setLocked(true);
  await vi.waitFor(() => expect(owner.pending).toHaveBeenLastCalledWith(false));
  expect(owner.history.commandCount).toBe(0);
  expect(owner.store.get(IDS.target)?.element.locked).not.toBe(true);
  owner.session.dispose();
});

it("does not lock a new selection while the original text field finishes saving", async () => {
  let finish: (saved: boolean) => void = () => undefined;
  const flushed = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const owner = harness(() => flushed);
  owner.select(new Set([IDS.target]));
  owner.session.setLocked(true);
  owner.select(new Set([IDS.highlight]));
  finish(true);
  await vi.waitFor(() => expect(owner.pending).toHaveBeenLastCalledWith(false));
  expect(owner.history.commandCount).toBe(0);
  expect(owner.store.get(IDS.target)?.element.locked).not.toBe(true);
  expect(owner.store.get(IDS.highlight)?.element.locked).toBe(true);
  owner.session.dispose();
});

it("cancels lock preparation when its presentation is disposed", async () => {
  const owner = harness();
  const prepare = owner.model.prepareElementReplacement.bind(owner.model);
  let finished: () => void = () => undefined;
  const preparedResult = new Promise<void>((resolve) => {
    finished = resolve;
  });
  owner.model.prepareElementReplacement = async (elements, cancellation) => {
    const prepared = await prepare(elements, cancellation);
    owner.session.dispose();
    finished();
    return prepared;
  };
  owner.session.setLocked(true);
  await preparedResult;
  await Promise.resolve();
  expect(owner.history.commandCount).toBe(0);
  expect(owner.store.get(IDS.target)?.element.locked).not.toBe(true);
});
