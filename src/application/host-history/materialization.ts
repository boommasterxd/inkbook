import type { CommandResultV1 } from "../note-session";
import type { ActionableHistoryEntrySnapshotV1 } from "./types";

export interface HostHistoryMaterializationV1 {
  materialize(
    entry: ActionableHistoryEntrySnapshotV1,
    direction: "forward" | "inverse",
  ): Promise<CommandResultV1<ActionableHistoryEntrySnapshotV1>>;
}
