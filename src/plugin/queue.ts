export interface Clock {
  set(callback: () => void, ms: number): number;
  clear(id: number): void;
}
/** Per-note debounce, deduplicated pending jobs, and one worker for the whole vault. */
export class WorkQueue<T> {
  private timers = new Map<T, { id: number; force: boolean }>();
  private pending = new Map<T, boolean>();
  private working = false;
  private stopped = false;
  constructor(
    private clock: Clock,
    private run: (key: T, force: boolean) => Promise<void>,
    private onError: (error: unknown) => void,
    private onIdle: () => void = () => {},
  ) {}
  schedule(key: T, ms: number, force = false) {
    if (this.stopped) return;
    const old = this.timers.get(key);
    if (old !== undefined) this.clock.clear(old.id);
    force = force || (old?.force ?? false) || (this.pending.get(key) ?? false);
    this.pending.delete(key);
    this.timers.set(key, {
      force,
      id: this.clock.set(() => {
        this.timers.delete(key);
        this.add(key, force);
      }, ms),
    });
  }
  add(key: T, force = true) {
    if (this.stopped) return;
    const old = this.timers.get(key);
    if (old !== undefined) {
      this.clock.clear(old.id);
      this.timers.delete(key);
    }
    this.pending.set(key, force || (this.pending.get(key) ?? false));
    void this.drain();
  }
  remove(key: T) {
    const timer = this.timers.get(key);
    if (timer !== undefined) this.clock.clear(timer.id);
    this.timers.delete(key);
    this.pending.delete(key);
  }
  clear() {
    for (const timer of this.timers.values()) this.clock.clear(timer.id);
    this.timers.clear();
    this.pending.clear();
  }
  stop() {
    this.stopped = true;
    this.clear();
  }
  get size() {
    return this.pending.size + this.timers.size + (this.working ? 1 : 0);
  }
  private async drain() {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      while (this.pending.size && !this.stopped) {
        const next = this.pending.entries().next();
        if (next.done) break;
        const [key, force] = next.value;
        this.pending.delete(key);
        try {
          await this.run(key, force);
        } catch (error) {
          this.onError(error);
        }
      }
    } finally {
      this.working = false;
      if (!this.pending.size) this.onIdle();
    }
  }
}
