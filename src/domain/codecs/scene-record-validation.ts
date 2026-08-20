import type { ElementId, GroupId } from "../model";
import { parseElementId, parseGroupId } from "../model";
import {
  canonicalRotation,
  closedRecord,
  closedValue,
} from "../model/validation-support";
import type { GroupRecordV1, NoteAppearanceV1 } from "../scene";
import {
  materializeGroupRecordV1,
  materializeNoteAppearanceV1,
} from "../scene";

const MIN_GROUP_CHILDREN = 2;

export function validateGroupRecordV1(value: unknown): GroupRecordV1 {
  const data = closedRecord(
    value,
    ["childIds", "groupId", "selectionRotationRadians"],
    "Group",
  );
  if (typeof data.groupId !== "string") {
    throw new TypeError("Group ID must be a string.");
  }
  data.groupId = parseGroupId(data.groupId);
  if (!Array.isArray(data.childIds)) {
    throw new TypeError("Group children must be an array.");
  }
  if (data.childIds.length < MIN_GROUP_CHILDREN) {
    throw new RangeError("A group requires at least two direct children.");
  }
  data.childIds = Object.freeze(
    data.childIds.map((child) => validateGroupChildId(child)),
  );
  canonicalRotation(data.selectionRotationRadians, "Group selection rotation");
  return materializeGroupRecordV1(data as unknown as GroupRecordV1);
}

function validateGroupChildId(value: unknown): ElementId | GroupId {
  if (typeof value !== "string") {
    throw new TypeError("Group child IDs must be strings.");
  }
  return value.startsWith("el_") ? parseElementId(value) : parseGroupId(value);
}

export function validateNoteAppearanceV1(value: unknown): NoteAppearanceV1 {
  const data = closedRecord(
    value,
    ["background", "contrast", "horizontalSpacing"],
    "Note appearance",
  );
  closedValue(
    data.background,
    ["none", "ruled", "squared", "dotted"],
    "Note background",
  );
  closedValue(
    data.horizontalSpacing,
    ["compact", "standard", "wide"],
    "Note spacing",
  );
  closedValue(data.contrast, ["low", "medium", "high"], "Note contrast");
  return materializeNoteAppearanceV1(data as unknown as NoteAppearanceV1);
}
