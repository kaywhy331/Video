import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppContext } from './app-context';
import {
  AcquisitionAttestSchema,
  AcquisitionBatchAttestSchema,
  AcquisitionMapFileSchema,
  AnalyticsSnapshotSchema,
  AnalyticsCollectSchema,
  AmbiguousMappingResolveSchema,
  ApprovePublicationSchema,
  BackupRestoreSchema,
  CatalogSearchRequestSchema,
  CatalogBulkUpdateSchema,
  CatalogExportSchema,
  CatalogReviewSuggestionSchema,
  CatalogRefreshSchema,
  CatalogSuggestionSchema,
  CatalogUpdateAssetSchema,
  CreateAutopilotProjectSchema,
  ExceptionListSchema,
  ExceptionOverrideSchema,
  ExceptionResolveSchema,
  ExceptionRetrySchema,
  ExternalUrlSchema,
  FinalReviewRevisionSchema,
  IdSchema,
  ImportRequestSchema,
  IPC,
  OpenPathSchema,
  PackageSelectSchema,
  PathChoiceRequestSchema,
  PlaceMergeSchema,
  PlaceSplitSchema,
  LearningDecisionSchema,
  LearningRecommendationSchema,
  MusicImportSchema,
  MusicSelectSchema,
  KeywordMetricObservationSchema,
  GoogleSheetsSyncSchema,
  ChannelProfileSchema,
  LanguageVoiceProfileSchema,
  ProjectExportSchema,
  ProjectRebuildSchema,
  RenderRequestSchema,
  SecretPatchSchema,
  SemanticVerificationRetrySchema,
  StoryboardMergeBeatsSchema,
  StoryboardRejectCandidateSchema,
  StoryboardReplaceShotSchema,
  StoryboardRewriteBeatSchema,
  StoryboardSceneSchema,
  StoryboardSplitBeatSchema,
  StoryboardUseGraphicSchema,
  StoryboardVerifyLocationSchema,
  SettingsPatchSchema,
  SettingsProfilePathSchema,
  StorageCleanupSchema
} from '@shared/contracts';
import type { AppSettings } from '@shared/types';
import { assertAllowedExternalUrl, assertAuthorizedIpcSender, pathIsInside } from './security-policy';
import { is } from '@electron-toolkit/utils';
import { canTransitionProject } from '@shared/state-machine';

function validateSender(
  event: Electron.IpcMainInvokeEvent,
  authorizedWebContents: Electron.WebContents | null,
  development = is.dev,
  productionEntryUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href
): void {
  assertAuthorizedIpcSender(event, authorizedWebContents, development, productionEntryUrl);
}


async function openDialog(
  owner: BrowserWindow | null,
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
}

function registerHandle(
  context: AppContext,
  window: () => BrowserWindow | null,
  channel: string,
  callback: (event: Electron.IpcMainInvokeEvent, payload: unknown) => unknown | Promise<unknown>
): void {
  ipcMain.handle(channel, async (event, payload) => {
    validateSender(event, window()?.webContents ?? null);
    return context.runOperation(`ipc:${channel}`, () => callback(event, payload));
  });
}

export function registerIpc(context: AppContext, window: () => BrowserWindow | null): void {
  const handle = (
    channel: string,
    callback: (event: Electron.IpcMainInvokeEvent, payload: unknown) => unknown | Promise<unknown>
  ): void => registerHandle(context, window, channel, callback);
  const catalogImportStatus = () =>
    context.catalogImports.status() ?? context.expansion.googleSheetOperationStatus();

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
        app.quit();
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
  handle(IPC.settingsProfileExport, async (_event, payload) => {
    let path = SettingsProfilePathSchema.parse(payload);
    if (path && !pathIsInside(path, [context.settings().backupFolder])) {
      throw new Error('Programmatic settings-profile exports must target the configured backup directory.');
    }
    if (!path) {
      const options: Electron.SaveDialogOptions = {
        title: 'Export a secret-free settings profile',
        defaultPath: 'videofactory-settings.vfsettings.json',
        filters: [{ name: 'VideoFactory settings', extensions: ['json'] }]
      };
      const owner = window();
      const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      path = result.filePath;
    }
    return path ? context.settingsProfiles.export(path) : null;
  });
  handle(IPC.settingsProfileImport, async (_event, payload) => {
    let path = SettingsProfilePathSchema.parse(payload);
    if (!path) {
      const result = await openDialog(window(), {
        title: 'Import a VideoFactory settings profile',
        properties: ['openFile'],
        filters: [{ name: 'VideoFactory settings', extensions: ['json'] }]
      });
      path = result.filePaths[0];
    }
    if (!path || !existsSync(path)) return null;
    return context.settingsProfiles.import(path);
  });
  handle(IPC.appCheckUpdate, () => context.updates.check());
  handle(IPC.schedulerStatus, () => context.scheduler.status());
  handle(IPC.schedulerEvaluate, async () => {
    const result = await context.scheduler.evaluate('manual');
    context.emitState();
    return result;
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

  handle(IPC.catalogChooseImport, async (_event, payload) => {
    const operationId = payload ? IdSchema.parse(payload) : randomUUID();
    const result = await openDialog(window(), {
      title: 'Import footage metadata catalog',
      properties: ['openFile'],
      filters: [
        { name: 'Spreadsheets', extensions: ['xlsx', 'xls', 'csv'] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    context.setLongOperationActive(true);
    try {
      return await context.catalogImports.preview(operationId, { filePath: result.filePaths[0] });
    } finally {
      if (!context.catalogImports.status()) context.setLongOperationActive(false);
    }
  });
  handle(IPC.catalogPreviewImport, async (_event, payload) => {
    const request = ImportRequestSchema.parse(payload);
    const operationId = request.operationId ?? randomUUID();
    context.setLongOperationActive(true);
    try {
      return await context.catalogImports.preview(operationId, request);
    } finally {
      if (!context.catalogImports.status()) context.setLongOperationActive(false);
    }
  });
  handle(IPC.catalogCancelImport, (_event, payload) => context.catalog.cancelImportPreview(IdSchema.parse(payload)));
  handle(IPC.catalogCancelOperation, (_event, payload) => {
    const operationId = IdSchema.parse(payload);
    return context.expansion.cancelGoogleSheetOperation(operationId)
      || context.catalogImports.cancel(operationId);
  });
  handle(IPC.catalogImportStatus, catalogImportStatus);
  handle(IPC.catalogPing, () => ({
    receivedAt: Date.now(),
    activeOperation: catalogImportStatus()
  }));
  handle(IPC.catalogCommitImport, async (_event, payload) => {
    const request = ImportRequestSchema.parse(payload);
    const operationId = request.operationId ?? randomUUID();
    context.setLongOperationActive(true);
    try {
      const result = await context.catalogImports.commit(operationId, request);
      context.catalog.invalidateSearchCaches();
      context.emitState();
      return result;
    } finally {
      if (!context.catalogImports.status()) context.setLongOperationActive(false);
    }
  });
  handle(IPC.catalogBulkUpdate, (_event, payload) => {
    const request = CatalogBulkUpdateSchema.parse(payload);
    const result = context.catalog.bulkUpdateAssets(request.assetIds, request.patch, request.reason);
    context.emitState();
    return result;
  });
  handle(IPC.catalogMetadataAssertions, (_event, payload) => context.catalog.metadata.list(IdSchema.parse(payload)));
  handle(IPC.catalogMetadataInbox, (_event, payload) => context.catalog.metadata.inbox(
    typeof payload === 'number' ? payload : 500
  ));
  handle(IPC.catalogSuggestMetadata, (_event, payload) => context.catalog.metadata.propose(CatalogSuggestionSchema.parse(payload)));
  handle(IPC.catalogReviewSuggestion, (_event, payload) => {
    const request = CatalogReviewSuggestionSchema.parse(payload);
    const result = context.catalog.metadata.review(request.assertionId, request.decision);
    context.catalog.invalidateSearchCaches();
    context.emitState();
    return result;
  });
  handle(IPC.catalogExportFiltered, async (_event, payload) => {
    const request = CatalogExportSchema.parse(payload);
    let outputPath = request.outputPath;
    if (!outputPath) {
      const owner = window();
      const options: Electron.SaveDialogOptions = {
        title: 'Export filtered catalog rows',
        defaultPath: 'videofactory-filtered-catalog.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      };
      const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      outputPath = result.filePath;
    }
    if (!outputPath) return null;
    return context.catalog.exportFiltered(request.request, outputPath);
  });
  handle(IPC.placesList, (_event, payload) => context.places.list(
    payload === undefined || payload === null ? undefined : IdSchema.parse(payload)
  ));
  handle(IPC.placesMerge, (_event, payload) => {
    const request = PlaceMergeSchema.parse(payload);
    const result = context.places.merge(request.sourcePlaceIds, request.targetPlaceId, request.reason);
    context.catalog.invalidateSearchCaches();
    context.emitState();
    return result;
  });
  handle(IPC.placesSplit, (_event, payload) => {
    const request = PlaceSplitSchema.parse(payload);
    const result = context.places.split(request);
    context.catalog.invalidateSearchCaches();
    context.emitState();
    return result;
  });
  handle(IPC.catalogSearch, (_event, payload) => context.catalog.search(CatalogSearchRequestSchema.parse(payload)));
  handle(IPC.catalogStats, () => context.catalog.stats());
  handle(IPC.catalogCoverage, (_event, payload) => {
    const limit = typeof payload === 'number' ? Math.max(10, Math.min(500, payload)) : 100;
    return context.catalog.coverage(limit);
  });
  handle(IPC.catalogValidationTemplates, () => context.catalog.validationTemplates());
  handle(IPC.catalogRefreshLatest, () => context.catalog.latestRefresh());
  handle(IPC.catalogRefreshRun, async (_event, payload) => {
    const request = CatalogRefreshSchema.parse(payload ?? {});
    const settings = context.settings();
    context.setLongOperationActive(true);
    try {
      const result = await context.catalogImports.refresh(request.operationId ?? randomUUID(), {
        filePath: request.sourcePath ?? settings.catalogImportFile,
        templateId: request.templateId ?? settings.catalogValidationTemplateId
      });
      context.catalog.invalidateSearchCaches();
      context.emitState();
      return result;
    } finally {
      if (!context.catalogImports.status()) context.setLongOperationActive(false);
    }
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

  handle(IPC.analyticsList, (_event, payload) => context.analytics.list(
    payload ? IdSchema.parse(payload) : undefined
  ));
  handle(IPC.analyticsImport, (_event, payload) => context.analytics.importSnapshot(
    AnalyticsSnapshotSchema.parse(payload)
  ));
  handle(IPC.analyticsCollect, (_event, payload) => {
    const request = AnalyticsCollectSchema.parse(payload);
    return context.analytics.collect(request.projectId, request.snapshotDay);
  });
  handle(IPC.analyticsCollectionRuns, (_event, payload) => context.analytics.collectionRuns(
    payload ? IdSchema.parse(payload) : undefined
  ));
  handle(IPC.learningList, () => context.analytics.recommendations());
  handle(IPC.learningPropose, (_event, payload) => context.analytics.propose(
    LearningRecommendationSchema.parse(payload)
  ));
  handle(IPC.learningDecide, async (_event, payload) => {
    const request = LearningDecisionSchema.parse(payload);
    const result = await context.analytics.decide(request.id, request.decision);
    context.emitState();
    return result;
  });
  handle(IPC.musicList, () => context.music.list());
  handle(IPC.musicSelection, (_event, payload) => context.music.getSelection(IdSchema.parse(payload)));
  handle(IPC.musicImport, async (_event, payload) => {
    const request = MusicImportSchema.parse(payload);
    let filePath = request.filePath;
    if (!filePath) {
      const result = await openDialog(window(), {
        title: 'Import licensed background music',
        properties: ['openFile'],
        filters: [{ name: 'Audio files', extensions: ['wav','mp3','m4a','aac','flac','ogg'] }]
      });
      filePath = result.filePaths[0];
    }
    if (!filePath) return null;
    const result = await context.music.import({ ...request, filePath });
    context.emitState();
    return result;
  });
  handle(IPC.musicSelect, (_event, payload) => {
    const request = MusicSelectSchema.parse(payload);
    const result = context.music.select(request.projectId, request.trackId, request.selectedBy);
    context.emitState();
    return result;
  });
  handle(IPC.storageCleanupLatest, () => context.storage.latest());
  handle(IPC.storageCleanup, (_event, payload) => {
    const request = StorageCleanupSchema.parse(payload ?? {});
    const result = context.storage.cleanup(request);
    context.emitState();
    return result;
  });
  handle(IPC.expansionRegistry, () => context.expansion.registry());
  handle(IPC.expansionSaveChannel, (_event, payload) => context.expansion.saveChannel(
    ChannelProfileSchema.parse(payload)
  ));
  handle(IPC.expansionSaveLanguage, (_event, payload) => context.expansion.saveLanguage(
    LanguageVoiceProfileSchema.parse(payload)
  ));
  handle(IPC.keywordMetricsList, (_event, payload) => context.expansion.keywordMetrics(
    payload ? IdSchema.parse(payload) : undefined
  ));
  handle(IPC.keywordMetricsImport, (_event, payload) => context.expansion.importKeywordMetric(
    KeywordMetricObservationSchema.parse(payload)
  ));
  handle(IPC.opportunityList, (_event, payload) => {
    const limit = payload === undefined ? 100 : Number(payload);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Opportunity list limit must be between 1 and 500.');
    }
    return context.expansion.opportunities(limit);
  });
  handle(IPC.googleSheetsSync, async (_event, payload) => {
    const request = GoogleSheetsSyncSchema.parse(payload);
    context.setLongOperationActive(true);
    try {
      return await context.expansion.stageGoogleSheet(request);
    } finally {
      if (!context.catalogImports.status()) context.setLongOperationActive(false);
    }
  });
  handle(IPC.googleSheetsRuns, () => context.expansion.googleSheetsRuns());
  handle(IPC.googleSheetsPreview, async (_event, payload) => {
    context.setLongOperationActive(true);
    try {
      return await context.expansion.stagedGoogleSheetPreview(IdSchema.parse(payload));
    } finally {
      if (!context.catalogImports.status()) context.setLongOperationActive(false);
    }
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
    const result = await context.workflow.advance(projectId);
    context.emitState();
    return result;
  });
  handle(IPC.projectPause, (_event, payload) => {
    const result = context.projects.pause(IdSchema.parse(payload));
    context.emitState();
    return result;
  });
  handle(IPC.projectResume, (_event, payload) => {
    const result = context.projects.resume(IdSchema.parse(payload));
    context.emitState();
    context.queueWorkflow(result.id);
    return result;
  });
  handle(IPC.projectCancel, (_event, payload) => {
    const result = context.projects.cancel(IdSchema.parse(payload));
    context.emitState();
    return result;
  });
  handle(IPC.projectArchive, (_event, payload) => {
    const result = context.projects.archive(IdSchema.parse(payload));
    context.emitState();
    return result;
  });
  handle(IPC.projectExport, async (_event, payload) => {
    const request = ProjectExportSchema.parse(payload ?? {});
    let destinationPath = request.destinationPath;
    if (destinationPath && !pathIsInside(destinationPath, [context.settings().backupFolder])) {
      throw new Error('Programmatic project exports must target the configured backup directory.');
    }
    if (!destinationPath) {
      const result = await openDialog(window(), {
        title: 'Choose a folder for the project export',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: context.settings().backupFolder
      });
      destinationPath = result.filePaths[0];
    }
    if (!destinationPath) return null;
    context.setLongOperationActive(true);
    try {
      const report = await context.artifacts.exportProject(request.projectId, destinationPath, {
        includeOriginals: request.includeOriginals,
        includeFinalOutput: request.includeFinalOutput
      });
      context.emitState();
      return report;
    } finally {
      context.setLongOperationActive(false);
    }
  });
  handle(IPC.projectRebuildDerivatives, async (_event, payload) => {
    const request = ProjectRebuildSchema.parse(payload ?? {});
    context.setLongOperationActive(true);
    try {
      const report = await context.artifacts.rebuildProject(request.projectId);
      context.emitState();
      return report;
    } finally {
      context.setLongOperationActive(false);
    }
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
    let certificatePath: string | undefined;
    if (request.attachCertificate) {
      const selected = await openDialog(window(), {
        title: 'Attach a project license certificate',
        properties: ['openFile'],
        filters: [{ name: 'License certificates', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'txt'] }]
      });
      certificatePath = selected.filePaths[0];
      if (!certificatePath) return null;
    }
    const result = await context.acquisitions.attest(request.acquisitionId, certificatePath);
    context.emitState();
    return result;
  });
  handle(IPC.acquisitionBatchAttest, async (_event, payload) => {
    const request = AcquisitionBatchAttestSchema.parse(payload);
    let certificatePath: string | undefined;
    if (request.attachCertificate) {
      const selected = await openDialog(window(), {
        title: 'Attach one license certificate to this project batch',
        properties: ['openFile'],
        filters: [{ name: 'License certificates', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'txt'] }]
      });
      certificatePath = selected.filePaths[0];
      if (!certificatePath) return null;
    }
    const result = await context.acquisitions.attestProject(request.projectId, certificatePath);
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

  handle(IPC.storyboardGet, (_event, payload) => {
    const request = StoryboardSceneSchema.parse(payload);
    return context.storyboard.getRecoveryScene(request.projectId, request.sceneId);
  });
  handle(IPC.storyboardReplaceShot, (_event, payload) => {
    const result = context.storyboard.replaceShot(StoryboardReplaceShotSchema.parse(payload));
    context.emitState();
    return result;
  });
  handle(IPC.storyboardRewriteBeat, (_event, payload) => {
    const result = context.storyboard.rewriteBeat(StoryboardRewriteBeatSchema.parse(payload));
    context.emitState();
    return result;
  });
  handle(IPC.storyboardUseGraphic, (_event, payload) => {
    const result = context.storyboard.useGraphic(StoryboardUseGraphicSchema.parse(payload));
    context.emitState();
    return result;
  });
  handle(IPC.storyboardSplitBeat, (_event, payload) => {
    const result = context.storyboard.splitBeat(StoryboardSplitBeatSchema.parse(payload));
    context.emitState();
    return result;
  });
  handle(IPC.storyboardMergeBeats, (_event, payload) => {
    const result = context.storyboard.mergeBeats(StoryboardMergeBeatsSchema.parse(payload));
    context.emitState();
    return result;
  });
  handle(IPC.storyboardVerifyLocation, async (_event, payload) => {
    context.setLongOperationActive(true);
    try {
      const result = await context.storyboard.verifyLocation(StoryboardVerifyLocationSchema.parse(payload));
      context.emitState();
      return result;
    } finally {
      context.setLongOperationActive(false);
    }
  });
  handle(IPC.storyboardRejectCandidate, (_event, payload) => {
    const result = context.storyboard.rejectCandidate(StoryboardRejectCandidateSchema.parse(payload));
    context.emitState();
    return result;
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
  handle(IPC.renderFourKBlockers, (_event, payload) => context.renders.fourKBlockers(IdSchema.parse(payload)));
  handle(IPC.finalReviewGet, (_event, payload) => context.finalReview.get(IdSchema.parse(payload)));
  handle(IPC.finalReviewRevision, (_event, payload) => {
    const revision = context.finalReview.requestRevision(FinalReviewRevisionSchema.parse(payload));
    context.emitState();
    if (revision.status === 'in_progress') {
      context.queueWorkflow(revision.projectId);
    }
    return revision;
  });
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
      const result = await context.workflow.uploadPrivate(IdSchema.parse(payload));
      context.emitState();
      return result;
    } finally {
      context.setLongOperationActive(false);
    }
  });
  handle(IPC.youtubeApprove, async (_event, payload) => {
    const request = ApprovePublicationSchema.parse(payload);
    const result = await context.youtube.approve(request.projectId, request.action, request.scheduledAt);
    if (result.outcome === 'published' || result.outcome === 'scheduled') {
      context.analytics.scheduleCheckpoints(request.projectId);
    }
    context.emitState();
    return result;
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
  handle(IPC.exceptionOverride, (_event, payload) => {
    const request = ExceptionOverrideSchema.parse(payload);
    const result = context.exceptions.override(request.id, request.reason);
    context.emitState();
    return result;
  });
  handle(IPC.exceptionRetry, async (_event, payload) => {
    const request = ExceptionRetrySchema.parse(payload);
    const before = context.exceptions.get(request.id);
    if (!before.retryAction) throw new Error('This exception has no safe retry action.');
    context.setLongOperationActive(true);
    try {
      if (before.retryAction === 'semantic_verification') {
        await context.media.retrySemanticVerification(before.id);
        context.emitState();
        return context.exceptions.get(before.id);
      }
      if (!before.projectId) throw new Error('A retryable exception must belong to a project.');
      const evidence = before.evidence;
      context.exceptions.beginRetry(before.id);
      try {
        const current = context.projects.get(before.projectId);
        if (current.state === 'BLOCKED_EXCEPTION') context.projects.resume(before.projectId);
        if (before.retryAction === 'media_ingest') {
          const acquisitionId = typeof evidence.acquisitionId === 'string' ? evidence.acquisitionId : '';
          const filePath = typeof evidence.filePath === 'string' ? evidence.filePath : '';
          if (!acquisitionId || !filePath) throw new Error('The ingest retry is missing its persisted acquisition/file target.');
          await context.media.ingestAcquisition(acquisitionId, filePath);
        } else {
          await context.workflow.advance(before.projectId);
        }
      } catch (error) {
        context.exceptions.retryFailed(before.id, error);
        const project = context.projects.get(before.projectId);
        if (project.state !== 'BLOCKED_EXCEPTION' && canTransitionProject(project.state, 'BLOCKED_EXCEPTION')) {
          context.projects.states.transition(before.projectId, 'BLOCKED_EXCEPTION', {
            reason: 'Operator retry failed',
            prerequisites: { exceptionId: before.id, error: error instanceof Error ? error.message : String(error) }
          });
        }
        throw error;
      }
      context.emitState();
      return context.exceptions.get(before.id);
    } finally {
      context.setLongOperationActive(false);
    }
  });
  handle(IPC.ambiguousMappingGet, (_event, payload) =>
    context.ambiguousMappings.get(IdSchema.parse(payload))
  );
  handle(IPC.ambiguousMappingResolve, async (_event, payload) => {
    const request = AmbiguousMappingResolveSchema.parse(payload);
    context.setLongOperationActive(true);
    try {
      const result = await context.ambiguousMappings.resolve(request.exceptionId, request.acquisitionId);
      context.emitState();
      return result;
    } finally {
      context.setLongOperationActive(false);
    }
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
    const exportRoots = (context.db.raw.prepare(`
      SELECT export_path FROM project_export_runs WHERE status IN ('complete','partial')
    `).all() as Array<{ export_path: string }>).map(row => row.export_path);
    if (!pathIsInside(path, [settings.mediaLibraryFolder, settings.projectFolder, settings.outputFolder, settings.backupFolder, ...exportRoots])) {
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
