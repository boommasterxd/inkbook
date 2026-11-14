// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import {
  TABLE_SOURCE,
  activate,
  disposeTableEditors,
  mount,
} from "../../../../fixtures/obsidian/text-table-editor";

afterEach(disposeTableEditors);

it("reveals the first cell insertion through the host while retaining one source insertion", async () => {
  const onScroll = vi.fn(() => true);
  const { editor, settle, onError } = await mount(TABLE_SOURCE, false, onScroll);
  const input = activate(editor, 1, 0);
  const rect = { left: 10, right: 11, top: 320, bottom: 340 };
  vi.spyOn(input, "coordsAtPos").mockReturnValue(rect);
  const measure = vi.spyOn(input, "requestMeasure").mockImplementation(() => undefined);
  input.dispatch({
    changes: { from: 0, insert: "first " },
    selection: { anchor: 6 },
    scrollIntoView: true,
    userEvent: "input.type",
  });
  for (const [request] of measure.mock.calls)
    if (request?.write) request.write(request.read(input), input);
  expect(onScroll).toHaveBeenCalledExactlyOnceWith(rect);
  expect(input.scrollDOM.scrollTop).toBe(0);
  expect(editor.view.scrollDOM.scrollTop).toBe(0);
  expect(editor.inputView).toBe(input);
  await settle();
  expect(editor.source).toBe(TABLE_SOURCE.replace("one", "first one"));
  expect(onError).not.toHaveBeenCalled();
});
