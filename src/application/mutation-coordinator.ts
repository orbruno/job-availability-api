type Release = () => void;

type LockState = {
  tail: Promise<void>;
  pending: number;
};

/** A keyed, FIFO, in-process coordinator whose idle locks are evicted. */
export class MutationCoordinator {
  readonly #locks = new Map<string, LockState>();

  public get activeKeyCount(): number {
    return this.#locks.size;
  }

  public async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.#locks.get(key);
    const prior = existing?.tail ?? Promise.resolve();
    let release: Release = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state: LockState = existing ?? { tail: current, pending: 0 };
    state.pending += 1;
    state.tail = prior.then(() => current);
    this.#locks.set(key, state);
    await prior;
    try {
      return await operation();
    } finally {
      state.pending -= 1;
      release();
      if (state.pending === 0 && this.#locks.get(key) === state) {
        this.#locks.delete(key);
      }
    }
  }
}
