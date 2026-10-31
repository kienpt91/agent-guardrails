/** Time source. Everything that reads time or sleeps goes through this so tests are deterministic. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface ManualClockOptions {
  start?: number;
  /** Added to the time after every `now()` call; gives a stable, strictly increasing timeline. */
  tickMs?: number;
}

/** Deterministic clock: time only moves through `advance`, `sleep` (which advances instantly) and `tickMs`. */
export class ManualClock implements Clock {
  private time: number;
  private readonly tickMs: number;

  constructor(options: ManualClockOptions = {}) {
    this.time = options.start ?? Date.UTC(2026, 0, 1);
    this.tickMs = options.tickMs ?? 0;
  }

  now(): number {
    const current = this.time;
    this.time += this.tickMs;
    return current;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  sleep(ms: number): Promise<void> {
    this.time += ms;
    return Promise.resolve();
  }
}
