export interface ActiveOperation {
  id: number;
  label: string;
  startedAt: string;
}

export class OperationGateClosedError extends Error {
  constructor() {
    super('VideoFactory is shutting down and is not accepting new work.');
    this.name = 'OperationGateClosedError';
  }
}

/**
 * Owns asynchronous work that may touch application services or the database.
 * Closing admission is synchronous; draining never abandons an admitted task.
 */
export class OperationGate {
  private accepting = true;
  private sequence = 0;
  private readonly active = new Map<Promise<unknown>, ActiveOperation>();

  get isAccepting(): boolean {
    return this.accepting;
  }

  run<T>(label: string, work: () => T | Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new OperationGateClosedError());

    const metadata: ActiveOperation = {
      id: this.sequence += 1,
      label,
      startedAt: new Date().toISOString()
    };
    const operation = Promise.resolve().then(work);
    this.active.set(operation, metadata);
    operation.then(
      () => this.active.delete(operation),
      () => this.active.delete(operation)
    );
    return operation;
  }

  close(): void {
    this.accepting = false;
  }

  snapshot(): ActiveOperation[] {
    return [...this.active.values()].map(operation => ({ ...operation }));
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.keys()]);
    }
  }
}
