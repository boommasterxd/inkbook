import { resolveInkReferences } from "./references";
import {
  INK_IMPORT_FOLDER,
  type InkImportFile,
  type InkImportPorts,
  type InkImportPreview,
  type InkImportSource,
  type InkImportReference,
  type InkImportScanFinding,
} from "./types";

export const MAX_IMPORT_FILE_CHARS = 16 * 1024 * 1024;
export const MAX_IMPORT_PREVIEW_CHARS = 64 * 1024 * 1024;
export const MAX_IMPORT_SOURCES = 1_000;
export const MAX_IMPORT_REFERENCES = 10_000;
export const MAX_IMPORT_EMBED_CHARS = 8_192;

function siblingTarget(source: string, reserved: Set<string>): string {
  const stem = source.replace(/\.[^./]+$/u, "");
  let path = `${stem}.inkbook.svg`;
  let index = 1;
  while (reserved.has(path)) path = `${stem}.inkbook-${index++}.svg`;
  reserved.add(path);
  return path;
}

interface ScanState {
  readonly reserved: Set<string>;
  readonly notes: Record<string, string>;
  readonly sources: Map<string, { legacy: boolean; references: InkImportReference[] }>;
  readonly warnings: string[];
  readonly scanFindings: InkImportScanFinding[];
  retained: number;
  referenceCount: number;
  truncated: boolean;
}

function recordScanFinding(state: ScanState, finding: InkImportScanFinding): void {
  const chars =
    finding.original.length +
    finding.message.length +
    finding.sources.reduce((total, path) => total + path.length, 0) +
    finding.notes.reduce((total, path) => total + path.length, 0);
  if (
    state.scanFindings.length >= MAX_IMPORT_REFERENCES ||
    state.retained + chars > MAX_IMPORT_PREVIEW_CHARS
  ) {
    state.truncated = true;
    return;
  }
  state.retained += chars;
  state.warnings.push(finding.original);
  state.scanFindings.push(finding);
}

function retainReference(
  ref: InkImportReference & { readonly legacy: boolean },
  state: ScanState,
): void {
  if (
    state.referenceCount >= MAX_IMPORT_REFERENCES ||
    ref.original.length > MAX_IMPORT_EMBED_CHARS ||
    state.retained + ref.original.length > MAX_IMPORT_PREVIEW_CHARS
  ) {
    state.truncated = true;
    return;
  }
  if (!state.reserved.has(ref.sourcePath)) {
    recordScanFinding(state, {
      original: `Missing source: ${ref.sourcePath}`,
      message: "Missing source",
      sources: [ref.sourcePath],
      notes: [ref.notePath],
    });
    return;
  }
  state.referenceCount += 1;
  state.retained += ref.original.length;
  const group = state.sources.get(ref.sourcePath);
  if (group !== undefined) group.references.push(ref);
  else if (state.sources.size < MAX_IMPORT_SOURCES)
    state.sources.set(ref.sourcePath, { legacy: ref.legacy, references: [ref] });
  else state.truncated = true;
}

async function scanNote(
  ports: InkImportPorts,
  file: InkImportFile,
  state: ScanState,
  signal?: AbortSignal,
): Promise<void> {
  if (file.size > MAX_IMPORT_FILE_CHARS) {
    state.truncated = true;
    return;
  }
  const note = await ports.read(file.path);
  if (note.length > MAX_IMPORT_FILE_CHARS) {
    state.truncated = true;
    return;
  }
  const refs = await resolveInkReferences({
    note,
    notePath: file.path,
    resolve: ports.resolveLink.bind(ports),
    scheduler: ports.workScheduler,
    ...(signal === undefined ? {} : { signal }),
    unresolved: (link) =>
      recordScanFinding(state, {
        original: `Unresolved writing reference in ${file.path}: ${link}`,
        message: "Unresolved writing reference",
        sources: [link],
        notes: [file.path],
      }),
  });
  if (refs.length >= MAX_IMPORT_REFERENCES) state.truncated = true;
  if (refs.length === 0) return;
  state.notes[file.path] = await ports.hash(note);
  for (const ref of refs) retainReference(ref, state);
}

async function previewSources(
  ports: InkImportPorts,
  state: ScanState,
  files: ReadonlyMap<string, InkImportFile>,
  signal?: AbortSignal,
): Promise<InkImportSource[]> {
  const previewSources: InkImportSource[] = [];
  for (const [path, group] of state.sources) {
    signal?.throwIfAborted();
    await ports.workScheduler.checkpoint(signal, "background");
    const file = files.get(path);
    if (file === undefined || file.size > MAX_IMPORT_FILE_CHARS) {
      state.truncated = true;
      continue;
    }
    try {
      const content = await ports.read(path);
      if (content.length > MAX_IMPORT_FILE_CHARS) {
        state.truncated = true;
        continue;
      }
      const converted = await ports.convert(content, {
        ...(signal === undefined ? {} : { signal }),
        legacyWriting: group.legacy,
      });
      if (converted.svg.length > MAX_IMPORT_FILE_CHARS) {
        state.truncated = true;
        continue;
      }
      previewSources.push({
        path,
        hash: await ports.hash(content),
        legacyWriting: group.legacy,
        targetPath: siblingTarget(path, state.reserved),
        references: group.references,
        warnings: converted.warnings,
      });
      state.warnings.push(...converted.warnings.map((warning) => `${path}: ${warning}`));
    } catch {
      signal?.throwIfAborted();
      recordScanFinding(state, {
        original: `Unsupported or invalid writing source: ${path}`,
        message: "Unsupported or invalid writing source",
        sources: [path],
        notes: [...new Set(group.references.map((reference) => reference.notePath))],
      });
    }
  }
  return previewSources;
}

export async function scanInkImports(
  ports: InkImportPorts,
  signal?: AbortSignal,
): Promise<InkImportPreview> {
  const allFiles = ports.listFiles();
  const filesByPath = new Map(allFiles.map((file) => [file.path, file]));
  const notes = allFiles.filter(
    (file) => file.path.endsWith(".md") && !file.path.startsWith(`${INK_IMPORT_FOLDER}/`),
  );
  const state: ScanState = {
    reserved: new Set(filesByPath.keys()),
    notes: {},
    sources: new Map(),
    warnings: [],
    scanFindings: [],
    retained: 0,
    referenceCount: 0,
    truncated: false,
  };
  for (const file of notes) {
    signal?.throwIfAborted();
    await ports.workScheduler.checkpoint(signal, "background");
    try {
      await scanNote(ports, file, state, signal);
    } catch {
      signal?.throwIfAborted();
      recordScanFinding(state, {
        original: `Could not inspect note: ${file.path}`,
        message: "Could not inspect note",
        sources: [],
        notes: [file.path],
      });
    }
  }
  const sources = await previewSources(ports, state, filesByPath, signal);
  if (state.truncated)
    state.warnings.push(
      "The bounded scan omitted files. Run another import after reviewing this batch.",
    );
  return {
    id: ports.createRunId(),
    sources,
    notes: state.notes,
    warnings: state.warnings,
    scanFindings: state.scanFindings,
    truncated: state.truncated,
  };
}
