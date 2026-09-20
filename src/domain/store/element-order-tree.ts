interface OrderNode {
  id: string;
  left: OrderNode | undefined;
  right: OrderNode | undefined;
  parent: OrderNode | undefined;
  height: number;
  size: number;
}

function size(node: OrderNode | undefined): number {
  return node?.size ?? 0;
}

function height(node: OrderNode | undefined): number {
  return node?.height ?? 0;
}

/** Mutable implicit AVL sequence; ranks are derived, never rewritten on siblings. */
export class ElementOrderTree {
  private root: OrderNode | undefined;
  private readonly nodes = new Map<string, OrderNode>();
  private visits = 0;

  get size(): number {
    return this.nodes.size;
  }

  /** Counts traversal steps and metadata updates, including balancing work. */
  get nodeVisits(): number {
    return this.visits;
  }

  resetInstrumentation(): void {
    this.visits = 0;
  }

  clear(): void {
    this.root = undefined;
    this.nodes.clear();
  }

  insert(id: string, rank: number): void {
    if (this.nodes.has(id)) throw new Error("Duplicate element order ID");
    if (!Number.isInteger(rank) || rank < 0 || rank > this.size) {
      throw new RangeError("Invalid element order rank");
    }
    const node: OrderNode = {
      id,
      left: undefined,
      right: undefined,
      parent: undefined,
      height: 1,
      size: 1,
    };
    this.nodes.set(id, node);
    if (!this.root) {
      this.root = node;
      return;
    }
    this.attach(node, rank);
    this.rebalance(node.parent);
  }

  remove(id: string): boolean {
    let node = this.nodes.get(id);
    if (!node) return false;
    this.visits += 1;
    if (node.left && node.right) {
      const successor = this.first(node.right);
      node.id = successor.id;
      this.nodes.set(node.id, node);
      node = successor;
    }
    const parent = node.parent;
    this.replace(node, node.left ?? node.right);
    this.nodes.delete(id);
    this.rebalance(parent);
    return true;
  }

  rankOf(id: string): number | undefined {
    let node = this.nodes.get(id);
    if (!node) return undefined;
    let rank = size(node.left);
    this.visits += 1;
    while (node.parent) {
      this.visits += 1;
      if (node === node.parent.right) rank += size(node.parent.left) + 1;
      node = node.parent;
    }
    return rank;
  }

  at(rank: number): string | undefined {
    if (!Number.isInteger(rank) || rank < 0 || rank >= this.size) return undefined;
    let node = this.root;
    while (node) {
      this.visits += 1;
      const leftSize = size(node.left);
      if (rank === leftSize) return node.id;
      if (rank < leftSize) node = node.left;
      else {
        rank -= leftSize + 1;
        node = node.right;
      }
    }
    return undefined;
  }

  /** Iteration assumes no concurrent mutation, like other live store iterators. */
  *ids(): IterableIterator<string> {
    const stack: OrderNode[] = [];
    let node = this.root;
    while (node || stack.length > 0) {
      while (node) {
        this.visits += 1;
        stack.push(node);
        node = node.left;
      }
      const current = stack.pop();
      if (!current) return;
      yield current.id;
      node = current.right;
    }
  }

  private attach(node: OrderNode, rank: number): void {
    let parent = this.root;
    while (parent) {
      this.visits += 1;
      const leftSize = size(parent.left);
      const side = rank <= leftSize ? "left" : "right";
      if (side === "right") rank -= leftSize + 1;
      const child = parent[side];
      if (!child) {
        parent[side] = node;
        node.parent = parent;
        return;
      }
      parent = child;
    }
  }

  private first(start: OrderNode): OrderNode {
    let node = start;
    this.visits += 1;
    while (node.left) {
      this.visits += 1;
      node = node.left;
    }
    return node;
  }

  private update(node: OrderNode): void {
    this.visits += 1;
    node.height = Math.max(height(node.left), height(node.right)) + 1;
    node.size = size(node.left) + size(node.right) + 1;
  }

  private replace(node: OrderNode, replacement: OrderNode | undefined): void {
    const parent = node.parent;
    if (!parent) this.root = replacement;
    else if (parent.left === node) parent.left = replacement;
    else parent.right = replacement;
    if (replacement) replacement.parent = parent;
  }

  private rotate(node: OrderNode, side: "left" | "right"): OrderNode {
    const opposite = side === "left" ? "right" : "left";
    const pivot = node[opposite];
    if (!pivot) throw new Error("Invalid element order rotation");
    this.replace(node, pivot);
    node[opposite] = pivot[side];
    if (node[opposite]) node[opposite].parent = node;
    pivot[side] = node;
    node.parent = pivot;
    this.update(node);
    this.update(pivot);
    return pivot;
  }

  private rebalance(start: OrderNode | undefined): void {
    let node = start;
    while (node) {
      this.update(node);
      node = this.balance(node).parent;
    }
  }

  private balance(node: OrderNode): OrderNode {
    const balance = height(node.left) - height(node.right);
    if (balance > 1 && node.left) {
      if (height(node.left.left) < height(node.left.right)) this.rotate(node.left, "left");
      return this.rotate(node, "right");
    }
    if (balance < -1 && node.right) {
      if (height(node.right.right) < height(node.right.left)) this.rotate(node.right, "right");
      return this.rotate(node, "left");
    }
    return node;
  }
}
