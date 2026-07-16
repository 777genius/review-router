export class ProviderCallLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxParallel: number) {
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 3) {
      throw new Error(
        'Provider call parallelism must be an integer from 1 to 3'
      );
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxParallel) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}
