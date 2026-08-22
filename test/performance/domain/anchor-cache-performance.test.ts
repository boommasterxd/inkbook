import { expect, it } from "vitest";

import { SemanticAnchorCache } from "../../../src/domain/store/semantic-anchor-cache";
import { rectangle } from "../../unit/domain/store/fixtures";

it("bounds semantic-anchor retention and reports deterministic LRU evictions", async ({
  annotate,
}) => {
  const maximumEntries = 128;
  const cache = new SemanticAnchorCache(maximumEntries, 1024 * 1024);
  for (let index = 0; index < maximumEntries * 2; index += 1) {
    const target = rectangle(`anchor-${String(index).padStart(4, "0")}`, index * 2, 0);
    expect(cache.resolve(target.id, 1, target).hit).toBe(false);
  }

  const retainedIndex = maximumEntries * 2 - 1;
  const retained = rectangle(
    `anchor-${String(retainedIndex).padStart(4, "0")}`,
    retainedIndex * 2,
    0,
  );
  expect(cache.resolve(retained.id, 1, retained).hit).toBe(true);
  const evicted = rectangle("anchor-0000", 0, 0);
  expect(cache.resolve(evicted.id, 1, evicted).hit).toBe(false);
  expect(cache.statistics()).toMatchObject({
    builds: maximumEntries * 2 + 1,
    entries: maximumEntries,
    evictions: maximumEntries + 1,
    hits: 1,
  });
  expect(cache.statistics().bytes).toBeLessThanOrEqual(1024 * 1024);
  await annotate(
    `anchor LRU: entries=${maximumEntries}, evictions=${maximumEntries + 1}, hits=1`,
    "performance",
  );
});
