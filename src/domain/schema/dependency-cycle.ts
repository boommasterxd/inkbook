interface DependencyFrame {
  readonly dependencies: readonly string[];
  readonly id: string;
  next: number;
}

export function hasReachableDependencyCycle(
  roots: Iterable<string>,
  dependenciesOf: (id: string) => readonly string[],
): boolean {
  const steps = hasReachableDependencyCycleSteps(roots, dependenciesOf);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export function* hasReachableDependencyCycleSteps(
  roots: Iterable<string>,
  dependenciesOf: (id: string) => readonly string[],
): Generator<void, boolean> {
  const states = new Map<string, "active" | "complete">();
  for (const root of roots) {
    yield;
    if (states.get(root) === "complete") continue;
    if (yield* visitDependencies(root, dependenciesOf, states)) return true;
  }
  return false;
}

function* visitDependencies(
  root: string,
  dependenciesOf: (id: string) => readonly string[],
  states: Map<string, "active" | "complete">,
): Generator<void, boolean> {
  const stack: DependencyFrame[] = [{ dependencies: dependenciesOf(root), id: root, next: 0 }];
  states.set(root, "active");
  while (stack.length > 0) {
    yield;
    const frame = stack[stack.length - 1]!;
    const dependency = frame.dependencies[frame.next];
    if (dependency === undefined) {
      states.set(frame.id, "complete");
      stack.pop();
      continue;
    }
    frame.next += 1;
    const state = states.get(dependency);
    if (state === "active") return true;
    if (state === "complete") continue;
    states.set(dependency, "active");
    stack.push({ dependencies: dependenciesOf(dependency), id: dependency, next: 0 });
  }
  return false;
}
