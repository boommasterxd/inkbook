import { afterEach, expect, it } from "vitest";

import { createSelection } from "../../../scripts/ci-selection.mjs";
import {
  cleanupRepositories,
  commit,
  createRepository,
  git,
  mergeBranch,
} from "./ci-selection-fixtures.mjs";

const value = "src/domain/value.ts";
const unrelated = "src/domain/unrelated.ts";
const consumer = "test/unit/domain/consumer.test.ts";
const other = "test/unit/domain/other.test.ts";
const fixture = "test/fixtures/consumer.ts";

afterEach(cleanupRepositories);

function repository() {
  return createRepository({
    [value]: "export const value = 1;",
    [unrelated]: "export const unrelated = 1;",
    [fixture]: 'export { value } from "../../src/domain/value";',
    [consumer]: 'import { value } from "../../fixtures/consumer"; void value;',
    [other]: 'import { unrelated } from "../../../src/domain/unrelated"; void unrelated;',
    "src/domain/appearance.ts": "export const color = 'red';",
    "docs/previous.md": "# Feature\n",
  });
}

it("selects transitive tests across the complete PR diff and retains both rename paths", async () => {
  const { root } = await repository();
  await git(root, "checkout", "--quiet", "-b", "feature");
  await commit(root, { [value]: "export const value = 2;" });
  const previousDoc = "docs/previous.md";
  const renamedDoc = "docs/renamed.md";
  await git(root, "mv", previousDoc, renamedDoc);
  const head = await commit(root, {
    "docs/feature.md": "# Note\n",
  });
  await git(root, "checkout", "--quiet", "main");
  const base = await commit(root, { [unrelated]: "export const unrelated = 2;" });
  await mergeBranch(root, "feature");

  expect(await createSelection({ root, base, head })).toMatchObject({
    mode: "affected",
    tests: [consumer],
    changes: ["docs/feature.md", previousDoc, renamedDoc, value].sort(),
  });
});

it("allows a code PR to skip tests only with a proven absence of test impact", async () => {
  const context = await repository();
  await commit(context.root, {
    "src/domain/appearance.ts": "export const color = 'blue';",
    "docs/feature.md": "# Feature\n",
  });

  expect(await createSelection(context)).toMatchObject({ mode: "no-impact", tests: [] });
});

it.each([
  ["an unresolved import", { [value]: 'import "./missing"; export const value = 2;' }],
  ["global tooling", { "vitest.config.ts": "export default {};" }],
  ["missing Git history", { "docs/feature.md": "# Feature\n" }],
])("falls back to the complete suite for %s", async (label, changes) => {
  const context = await repository();
  await commit(context.root, changes);
  if (label === "missing Git history") context.base = "missing";

  expect(await createSelection(context)).toMatchObject({ mode: "full", tests: [consumer, other] });
});

it("rechecks the full retained suite after a test is deleted", async () => {
  const context = await repository();
  await git(context.root, "rm", consumer);
  await commit(context.root);

  expect(await createSelection(context)).toMatchObject({ mode: "full", tests: [other] });
});

it("rejects a merge checkout different from the verified revision", async () => {
  const context = await repository();
  await commit(context.root, { [value]: "export const value = 2;" });

  await expect(createSelection({ ...context, merge: context.base })).rejects.toThrow(
    "expected merge revision",
  );
});
