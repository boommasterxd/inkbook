import type { LineElementV1 } from "../../../src/domain/schema/public";
import { uuid } from "../../unit/domain/schema/fixtures";
import { connectedLine } from "../../unit/domain/store/fixtures";

/** Every start resolves to the previous line's identical start anchor. */
export function connectionChain(size: number): LineElementV1[] {
  const source = { ...connectedLine(), startConnection: null };
  return Array.from({ length: size }, (_, index) => ({
    ...source,
    id: uuid(40_000 + index),
    startConnection:
      index === 0
        ? null
        : {
            anchor: { kind: "linear-endpoint", endpoint: "start" },
            targetId: uuid(40_000 + index - 1),
          },
  }));
}
