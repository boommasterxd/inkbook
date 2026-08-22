import type { InkElementV1 } from "../schema/public";

export type StoreAppendStatus = "accepted" | "cancelled";

export abstract class StoreAppendBuilder {
  public async append(elements: readonly InkElementV1[]): Promise<StoreAppendStatus> {
    return this.appendBatch(elements, false);
  }

  public async appendOwnedRuntime(elements: readonly InkElementV1[]): Promise<StoreAppendStatus> {
    return this.appendBatch(elements, true);
  }

  protected abstract appendBatch(
    elements: readonly InkElementV1[],
    ownsRuntimeElements: boolean,
  ): Promise<StoreAppendStatus>;
}
