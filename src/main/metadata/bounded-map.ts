// The one cache shape every metadata module uses. A gallery session is unbounded — the user can page
// through wallpapers for as long as they like — so anything remembered per key has to forget something
// eventually, and the rule for what is dropped belongs in one place rather than in each provider.
//
// Two budgets, because entries and bytes are genuinely different questions: a candidate or an offer is a
// small record and counting them is enough, while a thumbnail is a data: URL that can be megabytes on its
// own (Wallpaper Cave serves the tile and the full size as the SAME file). A limit stated only in entries
// puts no ceiling at all on the second kind.

/** An optional second budget: the cache also forgets once the values it holds weigh more than `bytes`. */
export interface BoundedMapBudget<T> {
  readonly bytes: number;
  /** What one value costs. For a string cache that is its length — base64 is one byte per character. */
  readonly sizeOf: (value: T) => number;
}

/** An LRU map: reading refreshes a key, and the oldest goes when either budget is exceeded. */
export class BoundedMap<T> {
  private readonly entries = new Map<string, T>();
  private weight = 0;

  constructor(
    private readonly limit: number,
    private readonly budget?: BoundedMapBudget<T>,
  ) {}

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    this.drop(key);
    this.entries.set(key, value);
    this.weight += this.weigh(value);
    while (this.entries.size > this.limit || this.overBudget()) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      // The value just inserted is the only one that may be over the budget by itself. Evicting it would
      // leave the caller holding a key the cache never had, so the last entry standing always stays.
      if (this.entries.size === 1) return;
      this.drop(oldest.value);
    }
  }

  private drop(key: string): void {
    const previous = this.entries.get(key);
    if (previous === undefined) return;
    this.weight -= this.weigh(previous);
    this.entries.delete(key);
  }

  private overBudget(): boolean {
    return this.budget !== undefined && this.weight > this.budget.bytes;
  }

  private weigh(value: T): number {
    return this.budget === undefined ? 0 : this.budget.sizeOf(value);
  }
}
