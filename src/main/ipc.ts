import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import type { AppContext } from './app-context';
import {
  ApprovePublicationSchema,
  CatalogSearchRequestSchema,
  CreateAutopilotProjectSchema,
  IdSchema,
  ImportRequestSchema,
  IPC,
  RenderRequestSchema,
  SecretPatchSchema,
  SettingsPatchSchema
} from '@shared/contracts';
import type { AppSettings } from '@shared/types';

function validateSender(event: Electron.IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? '';
  const isDev = url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
  const isPackaged = url.startsWith('file://');
  if (!isDev && !isPackaged) throw new Error('IPC sender is not authorized.');
}


async function openDialog(
  owner: BrowserWindow | null,
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
}

function handle(channel: string, callback: (event: Electron.IpcMainInvokeEvent, payload: unknown) => unknown | Promise<unknown>): void {
  ipcMain.handle(channel, async (event, payload) => {
    validateSender(event);
    return callback(event, payload);
  });
}

export function registerIpc(context: AppContext, window: () => BrowserWindow | null): void {
  handle(IPC.bootstrap, () => context.bootstrap());
  handle(IPC.diagnosticsRun, () => context.diagnostics.run());
  handle(IPC.settingsGet, () => context.settings());
  handle(IPC.settingsUpdate, async (_event, payload) => {
    const patch = SettingsPatchSchema.parse(payload) as Partial<AppSettings>;
    return context.updateSettings(patch);
  });
  handle(IPC.secretsUpdate, (_event, payload) => {
    const patch = SecretPatchSchema.parse(payload);
    return context.secrets.update(patch);
  });
  handle(IPC.pathsChoose, async (_event, payload) => {
    const request = payload as { kind: 'directory' | 'file'; title?: string; filters?: Electron.FileFilter[] };
    const result = await openDialog(window(), {
      title: request.title ?? 'Choose a path',
      properties: request.kind === 'directory' ? ['openDirectory', 'createDirectory'] : ['openFile'],
      filters: request.filters
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  handle(IPC.catalogChooseImport, async () => {
    const result = await openDialog(window(), {
      title: 'Import footage metadata catalog',
      properties: ['openFile'],
      filters: [
        { name: 'Spreadsheets', extensions: ['xlsx', 'xls', 'csv'] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return context.catalog.previewImport(result.filePaths[0]);
  });
  handle(IPC.catalogPreviewImport, (_event, payload) => {
    const request = ImportRequestSchema.pick({ filePath: true, sheetName: true }).parse(payload);
    return context.catalog.previewImport(request.filePath, request.sheetName);
  });
  handle(IPC.catalogCommitImport, (_event, payload) => {
    const request = ImportRequestSchema.parse(payload);
    const result = context.catalog.commitImport(request.filePath, request.sheetName, request.mapping);
    context.emitState();
    return result;
  });
  handle(IPC.catalogSearch, (_event, payload) => context.catalog.search(CatalogSearchRequestSchema.parse(payload)));
  handle(IPC.catalogStats, () => context.catalog.stats());
  handle(IPC.catalogCoverage, (_event, payload) => {
    const limit = typeof payload === 'number' ? Math.max(10, Math.min(500, payload)) : 100;
    return context.catalog.coverage(limit);
  });
  handle(IPC.catalogUpdateAsset, (_event, payload) => {
    const request = payload as { assetId: string; patch: Record<string, unknown>; reason?: string };
    IdSchema.parse(request.assetId);
    const result = context.catalog.updateAsset(request.assetId, request.patch, request.reason);
    context.emitState();
    return result;
  });

  handle(IPC.projectsList, () => context.projects.list());
  handle(IPC.projectGet, (_event, payload) => context.projects.get(IdSchema.parse(payload)));
  handle(IPC.projectCreateAutopilot, async (_event, payload) => {
    const project = await context.projects.createAutopilot(CreateAutopilotProjectSchema.parse(payload ?? {}));
    context.emitState();
    return project;
  });
  handle(IPC.projectAdvance, async (_event, payload) => {
    const projectId = IdSchema.parse(payload);
    const project = context.projects.get(projectId);
    if (project.state === 'STORYBOARD_FINAL' || project.state === 'QC_DRAFT') {
      const render = await context.renders.render(projectId, project.state === 'STORYBOARD_FINAL' ? 'draft' : 'final');
      context.emitState();
      return render;
    }
    if (project.state === 'WAITING_FINAL_APPROVAL' && !project.youtubeVideoId) {
      const result = await context.youtube.uploadPrivate(projectId);
      context.emitState();
      return result;
    }
    throw new Error(`No automatic advance is defined for project state ${project.state}.`);
  });
  handle(IPC.projectDelete, (_event, payload) => {
    context.projects.delete(IdSchema.parse(payload));
    context.emitState();
    return true;
  });

  handle(IPC.acquisitionList, (_event, payload) => context.acquisitions.list(payload ? IdSchema.parse(payload) : undefined));
  handle(IPC.acquisitionActivate, (_event, payload) => context.acquisitions.activate(IdSchema.parse(payload)));
  handle(IPC.acquisitionOpen, async (_event, payload) => {
    await context.acquisitions.open(IdSchema.parse(payload));
    context.emitState();
    return true;
  });
  handle(IPC.acquisitionAttest, (_event, payload) => {
    const request = payload as { acquisitionId: string; certificatePath?: string };
    const result = context.acquisitions.attest(IdSchema.parse(request.acquisitionId), request.certificatePath);
    context.emitState();
    return result;
  });
  handle(IPC.acquisitionMapFile, async (_event, payload) => {
    const request = payload as { acquisitionId: string; filePath?: string };
    let filePath = request.filePath;
    if (!filePath) {
      const result = await openDialog(window(), {
        title: 'Map downloaded video file',
        properties: ['openFile'],
        filters: [{ name: 'Video files', extensions: ['mp4', 'mov', 'mxf', 'm4v', 'avi', 'webm'] }]
      });
      filePath = result.filePaths[0];
    }
    if (!filePath || !existsSync(filePath)) throw new Error('Selected file does not exist.');
    await context.acquisitions.mapFile(IdSchema.parse(request.acquisitionId), filePath);
    context.emitState();
    return true;
  });

  handle(IPC.renderStart, async (_event, payload) => {
    const request = RenderRequestSchema.parse(payload);
    const result = await context.renders.render(request.projectId, request.kind);
    context.emitState();
    return result;
  });
  handle(IPC.finalReviewGet, (_event, payload) => context.finalReview.get(IdSchema.parse(payload)));
  handle(IPC.packagingSelect, (_event, payload) => {
    const request = payload as { projectId: string; packageId: string };
    IdSchema.parse(request.projectId);
    IdSchema.parse(request.packageId);
    const transaction = context.db.raw.transaction(() => {
      context.db.raw.prepare(`UPDATE packaging_candidates SET selected = 0 WHERE project_id = ?`).run(request.projectId);
      context.db.raw.prepare(`UPDATE packaging_candidates SET selected = 1 WHERE id = ? AND project_id = ?`)
        .run(request.packageId, request.projectId);
    });
    transaction();
    context.emitState();
    return context.finalReview.get(request.projectId);
  });

  handle(IPC.youtubeStatus, () => context.youtube.status());
  handle(IPC.youtubeAuthorize, () => context.youtube.authorize());
  handle(IPC.youtubeUploadPrivate, async (_event, payload) => {
    const result = await context.youtube.uploadPrivate(IdSchema.parse(payload));
    context.emitState();
    return result;
  });
  handle(IPC.youtubeApprove, async (_event, payload) => {
    const request = ApprovePublicationSchema.parse(payload);
    await context.youtube.approve(request.projectId, request.action, request.scheduledAt);
    context.emitState();
    return true;
  });

  handle(IPC.exceptionsList, (_event, payload) => {
    const request = (payload ?? {}) as { projectId?: string; openOnly?: boolean };
    return context.exceptions.list(request.projectId, request.openOnly ?? true);
  });
  handle(IPC.exceptionResolve, (_event, payload) => {
    const request = payload as { id: string; resolution?: Record<string, unknown> };
    const result = context.exceptions.resolve(IdSchema.parse(request.id), request.resolution);
    context.emitState();
    return result;
  });
  handle(IPC.jobsList, (_event, payload) => context.jobs.list(payload ? IdSchema.parse(payload) : undefined));
  handle(IPC.jobsRetry, (_event, payload) => context.jobs.retry(IdSchema.parse(payload)));

  handle(IPC.mediaOpenPath, async (_event, payload) => {
    const path = String(payload ?? '');
    if (!path || !existsSync(path)) throw new Error('Path does not exist.');
    shell.showItemInFolder(path);
    return true;
  });
  handle(IPC.externalOpen, async (_event, payload) => {
    const url = new URL(String(payload));
    if (url.protocol !== 'https:') throw new Error('Only HTTPS URLs may be opened.');
    const allowed = [
      'youtube.com', 'www.youtube.com', 'studio.youtube.com',
      'elements.envato.com', 'envato.com'
    ].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
    if (!allowed) throw new Error('External URL is not allowlisted.');
    await shell.openExternal(url.toString(), { activate: true });
    return true;
  });
}
