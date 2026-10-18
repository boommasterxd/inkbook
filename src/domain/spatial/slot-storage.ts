const SLOT_PAGE_SIZE = 32;

interface SlotPage<Value> {
  readonly owner: object;
  readonly entries: (SlotPage<Value> | Value | undefined)[];
  count: number;
}

interface SpatialSlotAccess<Value> {
  readonly length: number;
  readonly get: (slot: number) => Value | undefined;
}

export type SpatialSlotSource<Value> = SpatialSlotAccess<Value> | readonly (Value | undefined)[];

export function readSpatialSlot<Value>(
  slots: SpatialSlotSource<Value>,
  slot: number,
): Value | undefined {
  return "get" in slots ? slots.get(slot) : slots[slot];
}

export class SpatialSlots<Value> implements SpatialSlotAccess<Value> {
  private root: SlotPage<Value> | undefined;
  private owner: object = {};
  private capacity = SLOT_PAGE_SIZE;
  public length = 0;

  public fork(): SpatialSlots<Value> {
    this.owner = {};
    const fork = new SpatialSlots<Value>();
    fork.root = this.root;
    fork.capacity = this.capacity;
    fork.length = this.length;
    return fork;
  }

  public get(slot: number): Value | undefined {
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= this.capacity) return undefined;
    let page = this.root;
    for (let divisor = this.capacity / SLOT_PAGE_SIZE; divisor > 1; divisor /= SLOT_PAGE_SIZE) {
      page = page?.entries[Math.floor(slot / divisor) % SLOT_PAGE_SIZE] as
        SlotPage<Value> | undefined;
      if (page === undefined) return undefined;
    }
    return page?.entries[slot % SLOT_PAGE_SIZE] as Value | undefined;
  }

  public set(slot: number, value: Value | undefined): void {
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= Number.MAX_SAFE_INTEGER)
      throw new RangeError("Spatial slots require a nonnegative safe-integer address and length.");
    this.length = Math.max(this.length, slot + 1);
    if (value === undefined && (this.root === undefined || slot >= this.capacity)) return;
    while (slot >= this.capacity) {
      if (this.root !== undefined) {
        const parent = createSlotPage<Value>(this.owner);
        parent.entries[0] = this.root;
        parent.count = 1;
        this.root = parent;
      }
      this.capacity *= SLOT_PAGE_SIZE;
    }
    this.root = writeSlotPage(this.root, slot, value, this.capacity / SLOT_PAGE_SIZE, this.owner);
    this.compactRoot();
  }

  private compactRoot(): void {
    if (this.root === undefined) this.capacity = SLOT_PAGE_SIZE;
    while (
      this.capacity > SLOT_PAGE_SIZE &&
      this.root?.count === 1 &&
      this.root.entries[0] !== undefined
    ) {
      this.root = this.root.entries[0] as SlotPage<Value>;
      this.capacity /= SLOT_PAGE_SIZE;
    }
  }
}

function createSlotPage<Value>(owner: object): SlotPage<Value> {
  return {
    owner,
    count: 0,
    entries: new Array<SlotPage<Value> | Value | undefined>(SLOT_PAGE_SIZE),
  };
}

function writeSlotPage<Value>(
  page: SlotPage<Value> | undefined,
  slot: number,
  value: Value | undefined,
  divisor: number,
  owner: object,
): SlotPage<Value> | undefined {
  const offset = Math.floor(slot / divisor) % SLOT_PAGE_SIZE;
  const previous = page?.entries[offset];
  const next =
    divisor === 1
      ? value
      : writeSlotPage(
          previous as SlotPage<Value> | undefined,
          slot,
          value,
          divisor / SLOT_PAGE_SIZE,
          owner,
        );
  if (previous === next) return page;
  const source = page ?? createSlotPage<Value>(owner);
  const writable =
    source.owner === owner
      ? source
      : { owner, count: source.count, entries: source.entries.slice() };
  writable.entries[offset] = next;
  writable.count += Number(previous === undefined) - Number(next === undefined);
  return writable.count === 0 ? undefined : writable;
}

interface FreeSlot {
  readonly slot: number;
  readonly next: FreeSlot | undefined;
}

export class SpatialFreeSlots {
  private head: FreeSlot | undefined;

  public fork(): SpatialFreeSlots {
    const fork = new SpatialFreeSlots();
    fork.head = this.head;
    return fork;
  }

  public push(slot: number): void {
    this.head = { slot, next: this.head };
  }

  public pop(): number | undefined {
    const head = this.head;
    this.head = head?.next;
    return head?.slot;
  }
}
