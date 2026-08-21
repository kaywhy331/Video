export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface ShutdownCoordinatorOptions {
  stop: () => Promise<void>;
  completeQuit: () => void;
  onBegin?: () => void;
  onPending?: () => void;
  onError?: (error: unknown) => void;
  graceMs?: number;
}

type ShutdownState = 'idle' | 'stopping' | 'complete' | 'failed';

/** Holds Electron's first quit request until application work and SQLite are closed. */
export class ShutdownCoordinator {
  private state: ShutdownState = 'idle';
  private pendingTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ShutdownCoordinatorOptions) {}

  get isQuitting(): boolean {
    return this.state !== 'idle';
  }

  handleBeforeQuit(event: BeforeQuitEvent): void {
    if (this.state === 'complete') return;
    event.preventDefault();
    if (this.state !== 'idle') return;

    this.state = 'stopping';
    this.options.onBegin?.();
    this.pendingTimer = setTimeout(
      () => this.options.onPending?.(),
      this.options.graceMs ?? 30_000
    );
    this.pendingTimer.unref?.();

    void Promise.resolve()
      .then(() => this.options.stop())
      .then(() => {
        if (this.pendingTimer) clearTimeout(this.pendingTimer);
        this.state = 'complete';
        this.options.completeQuit();
      })
      .catch(error => {
        if (this.pendingTimer) clearTimeout(this.pendingTimer);
        this.state = 'failed';
        this.options.onError?.(error);
      });
  }
}
