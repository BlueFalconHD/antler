export class PathLockManager {
  private readonly tails = new Map<string, Promise<void>>();

  public async acquire(path: string): Promise<() => void> {
    const previous = this.tails.get(path) ?? Promise.resolve();
    let releaseTail: () => void = () => undefined;
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const queued = previous.then(() => tail);
    this.tails.set(path, queued);
    await previous;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      releaseTail();
      if (this.tails.get(path) === queued) {
        this.tails.delete(path);
      }
    };
  }
}
