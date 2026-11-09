import { expect, it } from "vitest";
import { appliedImportFixture } from "./import-fixture";

it("roundtrips localized recovery metadata and keeps it aligned when cleanup reasons are removed", async () => {
  const fixture = await appliedImportFixture();
  fixture.files.set("another.md", "[Reference](Ink/example.svg)");
  const skipped = await fixture.service.cleanup(fixture.preview.id);
  expect(skipped.journal.issueDetails).toEqual([
    { code: "cleanupReferenced", path: "Ink/example.svg" },
  ]);
  skipped.journal.issues.push("External diagnostic detail");
  fixture.files.set(fixture.journalPath, JSON.stringify(skipped.journal));
  expect((await fixture.service.history())[0]?.issueDetails?.[0]).toEqual({
    code: "cleanupReferenced",
    path: "Ink/example.svg",
  });
  fixture.files.delete("another.md");
  const cleaned = await fixture.service.cleanup(fixture.preview.id);
  expect(cleaned.journal.issues).toEqual(["External diagnostic detail"]);
  expect(cleaned.journal.issueDetails).toEqual([null]);
  expect((await fixture.service.history())[0]?.issueDetails).toEqual([null]);
});

it("preserves vault files when saved diagnostic metadata is malformed", async () => {
  const fixture = await appliedImportFixture();
  fixture.files.set(
    fixture.journalPath,
    JSON.stringify({
      ...fixture.journal,
      issues: ["Failure"],
      issueDetails: [{ code: "unrecognized" }],
    }),
  );
  const before = new Map(fixture.files);
  const saved = await fixture.service.history();
  expect(saved[0]?.unreadable).toBe(true);
  expect(fixture.files).toEqual(before);
});
