export type PowerBlockerHandler = (active: boolean) => void;

/**
 * Owns suspension-blocker demand with scoped, idempotent leases.
 * The underlying Electron blocker changes only at the zero/one boundaries,
 * so one completed operation cannot release protection still needed by another.
 */
export class LongOperationPowerGuard {
  private readonly leases = new Set<number>();
  private sequence = 0;
  private handler?: PowerBlockerHandler;

  get activeCount(): number {
    return this.leases.size;
  }

  setHandler(handler: PowerBlockerHandler): void {
    this.handler = handler;
    if (this.leases.size > 0) handler(true);
  }

  begin(): () => void {
    const id = this.sequence += 1;
    this.leases.add(id);
    try {
      if (this.leases.size === 1) this.handler?.(true);
    } catch (error) {
      this.leases.delete(id);
      try {
        this.handler?.(false);
      } catch {
        // Preserve the start failure while making a best effort to undo a partial handler transition.
      }
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!this.leases.delete(id)) return;
      if (this.leases.size === 0) this.handler?.(false);
    };
  }

  async run<T>(work: () => T | Promise<T>): Promise<T> {
    const release = this.begin();
    try {
      return await work();
    } finally {
      release();
    }
  }
}
