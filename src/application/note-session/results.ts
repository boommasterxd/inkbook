import type { CommandErrorCodeV1, CommandResultV1 } from "./types";

export function commandSuccess<T>(value: T): CommandResultV1<T> {
  return Object.freeze({ ok: true, value });
}

export function commandFailure<T = never>(
  code: CommandErrorCodeV1,
): CommandResultV1<T> {
  return Object.freeze({ code, ok: false });
}
