import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import type { AppContext } from './app-context';
import {
  AcquisitionAttestSchema,
  AcquisitionMapFileSchema,
  ApprovePublicationSchema,
  BackupRestoreSchema,
  CatalogSearchRequestSchema,
  CatalogUpdateAssetSchema,
  CreateAutopilotProjectSchema,
  ExceptionListSchema,
  ExceptionResolveSchema,
  ExternalUrlSchema,
  IdSchema,
  ImportRequestSchema,
  IPC,
  OpenPathSchema,
  PackageSelectSchema,
  PathChoiceRequestSchema,
  RenderRequestSchema,
  SecretPatchSchema,
  SemanticVerificationRetrySchema,
  SettingsPatchSchema
} from '@shared/contracts';
import type { AppSettings } from '@shared/types';
import { assertAllowedExternalUrl, isAllowedRendererUrl, pathIsInside } from './security-policy';
import { is } from '@electron-toolkit/utils';

function validateSender(event: Electron.IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC sender is not authorized.');
  }
  const url = event.senderFrame?.url ?? '';
  if (!isAllowedRendererUrl(url, is.dev)) throw new Error('IPC sender is not authorized.');
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
  handle(IPC.backupCreate, () => context.backups.create());
  handle(IPC.backupList, () => context.backups.list());
  handle(IPC.backupRestore, async (_event, payload) => {
    let backupPath = BackupRestoreSchema.parse(payload) ?? '';
    if (!backupPath) {
      const result = await openDialog(window(), {
        title: 'Restore a VideoFactory database backup',
        properties: ['openFile'],
        defaultPath: context.settings().backupFolder,
        filters: [{ name: 'SQLite backup', extensions: ['sqlite'] }]
      });
      backupPath = result.filePaths[0] ?? '';
    }
    if (!backupPath) return null;
    const report = context.backups.stageRestore(backupPath);
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: 'Restart to restore backup?',
      message: 'The selected backup passed integrity and checksum validation.',
      detail: 'VideoFactory will keep a safety copy of the current database, restart, restore the backup, and re-run migrations.',
      buttons: ['Restart and restore', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    };
    const owner = window();
    const confirmation = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    if (confirmation.response === 0) {
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 250).unref();
    } else {
      context.backups.cancelStagedRestore();
    }
    return report;
  });
  handle(IPC.settingsGet, () => context.settings());
  handle(IPC.settingsUpdate, async (_event, payload) => {
    const patch = SettingsPatchSchema.parse(payload) as Partial<AppSettings>;
    return context.updateSettings(patch);
  });
  handle(IPC.secretsUpdate, (_event, payload) => {
    const patch = SecretPatchSchema.parse(payload);
    const status = context.secrets.update(patch);
    const providers = [
      ...(patch.researchApiKey !== undefined ? ['tavily'] : []),
      ...(patch.llmApiKey !== undefined ? ['openai_compatible'] : []),
      ...(patch.visionApiKey !== undefined ? ['openai_compatible_vision'] : []),
      ...(patch.httpTtsApiKey !== undefined ? ['http_tts'] : [])
    ];
    for (const provider of providers) context.db.raw.prepare('DELETE FROM provider_health WHERE provider = ?').run(provider);
    return status;
  });
  handle(IPC.pathsChoose, async (_event, payload) => {
    const request = PathChoiceRequestSchema.parse(payload);
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
    const request = CatalogUpdateAssetSchema.parse(payload);
    const result = context.catalog.updateAsset(request.assetId, request.patch, request.reason);
    context.emitState();
    return result;
  });
  handle(IPC.catalogRevisions, (_event, payload) => context.catalog.revisions(IdSchema.parse(payload)));
  handle(IPC.catalogRevertRevision, (_event, payload) => {
    const result = context.catalog.revertRevision(IdSchema.parse(payload));
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
    if (project.state === 'FINALIZING_SCRIPT' || project.state === 'GENERATING_VOICE') {
      context.setLongOperationActive(true);
      try {
        if (project.state === 'FINALIZING_SCRIPT') await context.scriptFinalization.finalize(projectId);
        const result = await context.narration.generate(projectId);
        context.emitState();
        return result;
      } finally {
        context.setLongOperationActive(false);
      }
    }
    if (project.state === 'BUILDING_TIMELINE' || project.state === 'QC_DRAFT') {
      context.setLongOperationActive(true);
      try {
        const render = await context.renders.render(projectId, project.state === 'BUILDING_TIMELINE' ? 'draft' : 'final');
        context.emitState();
        return render;
      } finally {
        context.setLongOperationActive(false);
      }
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
  handle(IPC.acquisitionAttest, async (_event, payload) => {
    const request = AcquisitionAttestSchema.parse(payload);
    const result = await context.acquisitions.attest(request.acquisitionId, request.certificatePath);
    context.emitState();
    return result;
  });
  handle(IPC.acquisitionMapFile, async (_event, payload) => {
    const request = AcquisitionMapFileSchema.parse(payload);
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
    context.setLongOperationActive(true);
    try {
      const result = await context.renders.render(request.projectId, request);
      context.emitState();
      return result;
    } finally {
      context.setLongOperationActive(false);
    }
  });
  handle(IPC.finalReviewGet, (_event, payload) => context.finalReview.get(IdSchema.parse(payload)));
  handle(IPC.packagingSelect, (_event, payload) => {
    const request = PackageSelectSchema.parse(payload);
    const transaction = context.db.raw.transaction(() => {
      context.db.raw.prepare(`UPDATE packaging_candidates SET selected = 0 WHERE project_id = ?`).run(request.projectId);
      context.db.raw.prepare(`UPDATE packaging_candidates SET selected = 1 WHERE id = ? AND project_id = ?`)
        .run(request.packageId, request.projectId);
    });
    transaction();
    context.db.raw.prepare(`
      UPDATE publication_records SET approval_hash = NULL, approved_at = NULL, updated_at = ?
      WHERE project_id = ?
    `).run(new Date().toISOString(), request.projectId);
    context.emitState();
    return context.finalReview.get(request.projectId);
  });

  handle(IPC.youtubeStatus, () => context.youtube.status());
  handle(IPC.youtubeAuthorize, () => context.youtube.authorize());
  handle(IPC.youtubeUploadPrivate, async (_event, payload) => {
    context.setLongOperationActive(true);
    try {
      const result = await context.youtube.uploadPrivate(IdSchema.parse(payload));
      context.emitState();
      return result;
    } finally {
      context.setLongOperationActive(false);
    }
  });
  handle(IPC.youtubeApprove, async (_event, payload) => {
    const request = ApprovePublicationSchema.parse(payload);
    await context.youtube.approve(request.projectId, request.action, request.scheduledAt);
    context.emitState();
    return true;
  });

  handle(IPC.exceptionsList, (_event, payload) => {
    const request = ExceptionListSchema.parse(payload ?? {});
    return context.exceptions.list(request.projectId, request.openOnly ?? true);
  });
  handle(IPC.exceptionResolve, (_event, payload) => {
    const request = ExceptionResolveSchema.parse(payload);
    const result = context.exceptions.resolve(request.id, request.resolution);
    context.emitState();
    return result;
  });
  handle(IPC.semanticVerificationRetry, async (_event, payload) => {
    const request = SemanticVerificationRetrySchema.parse(payload);
    context.setLongOperationActive(true);
    try {
      const result = await context.media.retrySemanticVerification(request.exceptionId);
      context.emitState();
      return result;
    } finally {
      context.setLongOperationActive(false);
    }
  });
  handle(IPC.jobsList, (_event, payload) => context.jobs.list(payload ? IdSchema.parse(payload) : undefined));
  handle(IPC.jobsRetry, (_event, payload) => context.jobs.retry(IdSchema.parse(payload)));

  handle(IPC.mediaOpenPath, async (_event, payload) => {
    const path = OpenPathSchema.parse(payload);
    if (!path || !existsSync(path)) throw new Error('Path does not exist.');
    const settings = context.settings();
    if (!pathIsInside(path, [settings.mediaLibraryFolder, settings.projectFolder, settings.outputFolder, settings.backupFolder])) {
      throw new Error('Path is outside VideoFactory-managed storage.');
    }
    shell.showItemInFolder(path);
    return true;
  });
  handle(IPC.externalOpen, async (_event, payload) => {
    const url = assertAllowedExternalUrl(ExternalUrlSchema.parse(payload));
    await shell.openExternal(url.toString(), { activate: true });
    return true;
  });
}
