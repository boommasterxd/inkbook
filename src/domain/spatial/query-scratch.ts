export class SpatialQueryScratch<Id> {
  private allocationTotal = 0;
  private candidateTotal = 0;
  private duplicateTotal = 0;
  private epoch = 0;
  private markers = new Uint32Array(0);
  private resultSlots: (Id | undefined)[] = [];

  public count = 0;

  public get allocationCount(): number {
    return this.allocationTotal;
  }

  public get candidateVisitCount(): number {
    return this.candidateTotal;
  }

  public get duplicateVisitCount(): number {
    return this.duplicateTotal;
  }

  public get markerCapacity(): number {
    return this.markers.length;
  }

  public get resultCapacity(): number {
    return this.resultSlots.length;
  }

  public at(index: number): Id {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new RangeError("Spatial query result index is out of range.");
    }

    return this.resultSlots[index] as Id;
  }

  public begin(slotCapacity: number): void {
    this.clearResultReferences();
    this.candidateTotal = 0;
    this.duplicateTotal = 0;
    this.advanceEpoch();
    this.ensureMarkerCapacity(slotCapacity);
  }

  public visit(slot: number, id: Id, intersects: boolean): void {
    this.candidateTotal += 1;

    if (this.markers[slot] === this.epoch) {
      this.duplicateTotal += 1;
      return;
    }

    this.markers[slot] = this.epoch;
    if (!intersects) return;

    this.ensureResultCapacity(this.count + 1);
    this.resultSlots[this.count] = id;
    this.count += 1;
  }

  public release(): void {
    this.resultSlots.fill(undefined);
    this.resultSlots = [];
    this.markers = new Uint32Array(0);
    this.count = 0;
    this.epoch = 0;
  }

  private advanceEpoch(): void {
    if (this.epoch === 0xffff_ffff) {
      this.markers.fill(0);
      this.epoch = 1;
      return;
    }

    this.epoch += 1;
  }

  private clearResultReferences(): void {
    for (let index = 0; index < this.count; index += 1) {
      this.resultSlots[index] = undefined;
    }
    this.count = 0;
  }

  private ensureMarkerCapacity(required: number): void {
    if (required <= this.markers.length) return;

    const markers = new Uint32Array(required);
    markers.set(this.markers);
    this.markers = markers;
    this.allocationTotal += 1;
  }

  private ensureResultCapacity(required: number): void {
    if (required <= this.resultSlots.length) return;

    const capacity = Math.max(
      required,
      this.resultSlots.length === 0 ? 16 : this.resultSlots.length * 2,
    );
    const slots: (Id | undefined)[] = new Array<Id | undefined>(capacity);
    for (let index = 0; index < this.count; index += 1) slots[index] = this.resultSlots[index];
    this.resultSlots = slots;
    this.allocationTotal += 1;
  }
}
