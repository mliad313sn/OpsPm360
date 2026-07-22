/**
 * Dependency-graph utilities (pure). The project dependency network must stay
 * a DAG — cycles break schedule cascades and lock checks. Checked client-side
 * for fast feedback and re-checked server-side inside the write transaction
 * (two offline sites can each add half of a cycle).
 */

export interface Edge {
  from: string; // predecessor
  to: string; // successor
}

/** True if adding `candidate` to `edges` would create a cycle (DFS from candidate.to). */
export function wouldCreateCycle(edges: readonly Edge[], candidate: Edge): boolean {
  if (candidate.from === candidate.to) return true;

  const adjacency = new Map<string, string[]>();
  for (const e of [...edges, candidate]) {
    const list = adjacency.get(e.from);
    if (list) list.push(e.to);
    else adjacency.set(e.from, [e.to]);
  }

  // A cycle through the new edge exists iff candidate.from is reachable
  // from candidate.to.
  const stack = [candidate.to];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node === candidate.from) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of adjacency.get(node) ?? []) stack.push(next);
  }
  return false;
}

/** All nodes reachable downstream of `start` (successors, transitive). */
export function downstreamOf(edges: readonly Edge[], start: string): string[] {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.from);
    if (list) list.push(e.to);
    else adjacency.set(e.from, [e.to]);
  }
  const out: string[] = [];
  const visited = new Set<string>([start]);
  const stack = [...(adjacency.get(start) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (visited.has(node)) continue;
    visited.add(node);
    out.push(node);
    for (const next of adjacency.get(node) ?? []) stack.push(next);
  }
  return out;
}
