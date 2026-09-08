import { joinVaultPath, type ValidatedVaultPath } from "./vault-path";

const HEX_SUFFIX_BYTES = 3;

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatLocalTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    twoDigits(date.getMonth() + 1),
    twoDigits(date.getDate()),
    "-",
    twoDigits(date.getHours()),
    twoDigits(date.getMinutes()),
    twoDigits(date.getSeconds()),
  ].join("");
}

export interface RandomBytesSource {
  fill(bytes: Uint8Array): void;
}

export function createInkbookFilename(date: Date, random: RandomBytesSource): string {
  const suffixBytes = new Uint8Array(HEX_SUFFIX_BYTES);
  random.fill(suffixBytes);
  const suffix = Array.from(suffixBytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `inkbook-${formatLocalTimestamp(date)}-${suffix}.svg`;
}

export interface CollisionProbe {
  exists(path: ValidatedVaultPath): boolean | Promise<boolean>;
}

export async function findAvailableInkbookPath(
  directory: ValidatedVaultPath | null,
  date: Date,
  random: RandomBytesSource,
  probe: CollisionProbe,
  maximumAttempts = 32,
): Promise<ValidatedVaultPath> {
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const candidate = joinVaultPath(directory, createInkbookFilename(date, random));
    if (candidate !== null && !(await probe.exists(candidate))) {
      return candidate;
    }
  }
  throw new Error("inkbook-path-collision-limit");
}

export function migrationBackupPath(
  path: ValidatedVaultPath,
  oldVersion: number,
): ValidatedVaultPath {
  const suffix = `.backup-v${oldVersion}.svg`;
  const base = path.toLowerCase().endsWith(".svg") ? path.slice(0, -4) : path;
  return `${base}${suffix}` as ValidatedVaultPath;
}
