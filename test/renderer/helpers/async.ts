/** Lets pending microtask chains (`await api.listDir(…)`, `await load(id)`) settle before asserting. */
export async function flushAsync(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}
