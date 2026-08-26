import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '@shared/ipc-channels';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  updateSettings: vi.fn(async (patch: unknown) => patch)
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0-test', relaunch: vi.fn(), quit: vi.fn() },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      mocks.handlers.set(channel, handler);
    }
  },
  shell: {}
}));

vi.mock('@main/security-policy', () => ({
  assertAllowedExternalUrl: vi.fn(),
  assertAuthorizedIpcSender: vi.fn(),
  pathIsInside: vi.fn(() => true)
}));

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }));

import { registerIpc } from '@main/ipc';
import type { AppContext } from '@main/app-context';

beforeEach(() => {
  mocks.handlers.clear();
  mocks.updateSettings.mockClear();
});

describe('media tool IPC privilege boundary', () => {
  it('rejects executable paths through generic settings update before application state changes', async () => {
    const context = {
      runOperation: async (_label: string, work: () => unknown | Promise<unknown>) => work(),
      updateSettings: mocks.updateSettings,
      catalogImports: { status: () => null },
      expansion: { googleSheetOperationStatus: () => null }
    } as unknown as AppContext;
    registerIpc(context, () => null);
    const handler = mocks.handlers.get(IPC.settingsUpdate);
    expect(handler).toBeDefined();

    await expect(handler?.({}, { ffmpegPath: '/tmp/ffmpeg' })).rejects.toThrow();
    await expect(handler?.({}, { ffprobePath: '/tmp/ffprobe' })).rejects.toThrow();
    expect(mocks.updateSettings).not.toHaveBeenCalled();

    await expect(handler?.({}, { maxActiveProjects: 3 })).resolves.toEqual({ maxActiveProjects: 3 });
    expect(mocks.updateSettings).toHaveBeenCalledWith({ maxActiveProjects: 3 });
  });
});
