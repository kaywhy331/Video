export type OperatorShortcut =
  | 'next_download'
  | 'retry'
  | 'approve'
  | 'pause'
  | 'open_exception';

const SHORTCUTS: Record<string, OperatorShortcut> = {
  d: 'next_download',
  r: 'retry',
  a: 'approve',
  p: 'pause',
  e: 'open_exception'
};

export function resolveOperatorShortcut(input: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  editableTarget?: boolean;
}): OperatorShortcut | null {
  if (!input.ctrlKey || !input.altKey || input.repeat || input.editableTarget) return null;
  return SHORTCUTS[input.key.toLocaleLowerCase('en-US')] ?? null;
}

export function selectOperatorTarget<T extends {
  id: string;
  projectId: string | null;
  createdAt: string;
}>(candidates: T[], preferredProjectId: string | null): T | null {
  return [...candidates].sort((left, right) => {
    const leftPreferred = preferredProjectId && left.projectId === preferredProjectId ? 0 : 1;
    const rightPreferred = preferredProjectId && right.projectId === preferredProjectId ? 0 : 1;
    if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
    const byCreated = left.createdAt.localeCompare(right.createdAt);
    return byCreated || left.id.localeCompare(right.id);
  })[0] ?? null;
}
