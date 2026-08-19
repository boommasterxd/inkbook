import type { CdpSession } from "./cdp-session.mjs";
import type {
  RuntimeDiagnosticSnapshot,
  RuntimeDisposalSnapshot,
  RuntimeEnvironmentSnapshot,
} from "./obsidian-runtime-measurement.mjs";

export class ObsidianRuntimeHostError extends Error {}

export function buildObsidianHostExpression(
  action:
    | "preflight"
    | "run-environment-probe"
    | "disable-current"
    | "enable-next"
    | "ensure-enabled",
  expected: {
    pluginId: string;
    environmentProbeCommandId: string;
    markTimeoutMs: number;
    previousModuleEvaluatedAt?: number;
  },
): string;

export class ObsidianRuntimeHost {
  public constructor(
    session: CdpSession,
    expected: {
      pluginId: string;
      environmentProbeCommandId: string;
      markTimeoutMs: number;
    },
  );
  public initialize(): Promise<RuntimeDiagnosticSnapshot>;
  public runEnvironmentProbe(): Promise<RuntimeEnvironmentSnapshot>;
  public disableCurrent(
    previousModuleEvaluatedAt: number,
  ): Promise<RuntimeDisposalSnapshot>;
  public enableNext(previousModuleEvaluatedAt: number): Promise<{
    enableStartedAt: number;
    ready: RuntimeDiagnosticSnapshot;
  }>;
  public collectGarbage(): Promise<void>;
  public heapUsage(): Promise<{ totalSize: number; usedSize: number }>;
  public ensureEnabled(): Promise<RuntimeDiagnosticSnapshot>;
}
