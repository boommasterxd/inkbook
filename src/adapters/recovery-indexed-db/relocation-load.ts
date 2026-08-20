import {
  parseRelocationId,
  type CommandResultV1,
} from "../../application/note-session";
import type {
  LoadRelocationByIdV1,
  RelocationRecordV1,
} from "../../application/recovery";
import {
  admitQueueRequest,
  type AdmittedQueueRequest,
} from "./queue-admission";
import { readRecordByKey } from "./read-record";

const RELOCATION_ID_PROPERTY = "relocationId";

export function admitRelocationLoad(
  value: unknown,
): CommandResultV1<AdmittedQueueRequest<LoadRelocationByIdV1>> {
  try {
    if (typeof value !== "object" || value === null) return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== RELOCATION_ID_PROPERTY) {
      return invalid();
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(
      value,
      RELOCATION_ID_PROPERTY,
    );
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      return invalid();
    }
    const request = Object.freeze({
      relocationId: parseRelocationId(descriptor.value),
    });
    return admitQueueRequest(request);
  } catch {
    return invalid();
  }
}

export async function loadRelocationById(
  database: IDBDatabase,
  request: LoadRelocationByIdV1,
): Promise<CommandResultV1<RelocationRecordV1 | null>> {
  const loaded = await readRecordByKey(
    database,
    `relocation:${request.relocationId}`,
  );
  if (!loaded.ok) return loaded;
  if (loaded.value === null) return { ok: true, value: null };
  return "relocationId" in loaded.value.record &&
    loaded.value.record.relocationId === request.relocationId
    ? { ok: true, value: loaded.value.record }
    : { ok: false, code: "recovery-unavailable" };
}

function invalid<T>(): CommandResultV1<T> {
  return { ok: false, code: "invalid-command" };
}
