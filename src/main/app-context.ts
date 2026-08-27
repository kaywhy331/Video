import { app, BrowserWindow, Notification } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  AppSettings,
  AppBootstrap,
  AppStateSnapshot,
  OperationsHealth,
  ProviderEndpointId,
  QueueSummary,
  ProgressEvent,
  SecretStatus,
  SettingsPatch,
  MediaToolRole
} from '@shared/types';
import { buildDefaultSettings, ensureSettingsPaths } from './app-paths';
import { AppDatabase } from './database/database';
import { Logger } from './logger';
import { SecretStore, type Secrets } from './secret-store';
import { CatalogService } from './services/catalog-service';
import { CatalogImportWorkerService } from './services/catalog-import-worker-service';
import { DiagnosticsService } from './services/diagnostics-service';
import { AiService } from './services/ai-service';
import { ProjectService } from './services/project-service';
import { MediaService } from './services/media-service';
import { DownloadWatcher } from './services/download-watcher';
import { AcquisitionService } from './services/acquisition-service';
import { JobService } from './services/job-service';
import { TtsService } from './services/tts-service';
import { RenderService } from './services/render-service';
import { YouTubeService } from './services/youtube-service';
import { FinalReviewService } from './services/final-review-service';
import { ExceptionService } from './services/exception-service';
import { AmbiguousMappingService } from './services/ambiguous-mapping-service';
import { BackupService } from './services/backup-service';
import { IPC } from '@shared/ipc-channels';
import { PlaceService } from './services/place-service';
import { VisionService } from './services/vision-service';
import { FootageVerificationService } from './services/footage-verification-service';
import { ResearchService } from './services/research-service';
import { ProviderPolicyService } from './services/provider-policy';
import {
  normalizeLegacyProviderEndpointSettings,
  ProviderEndpointPolicy
} from './services/provider-endpoint-policy';
import { ScriptFinalizationService } from './services/script-finalization-service';
import { NarrationService } from './services/narration-service';
import { ProjectArtifactService } from './services/project-artifact-service';
import { SettingsProfileService, UpdateService } from './services/operations-service';
import { SchedulerService } from './services/scheduler-service';
import { AnalyticsService } from './services/analytics-service';
import { MusicService } from './services/music-service';
import { StorageService } from './services/storage-service';
import { ExpansionService } from './services/expansion-service';
import { GoogleProviderService } from './services/google-provider-service';
import { WorkflowService } from './services/workflow-service';
import { StoryboardService } from './services/storyboard-service';
import { OperationGate, type ActiveOperation } from './services/operation-gate';
import { classifyOperationsHealth } from '@shared/operations-health';
import { MediaToolService } from './services/media-tool-service';
import { installMediaToolResolver } from './tool-paths';
import { installProcessLaunchGuard } from './services/process-utils';
import { ActiveFinalService } from './services/active-final-service';
import { LongOperationPowerGuard } from './services/long-operation-power-guard';
import { initialSetupState, type InitialSetupState } from '@shared/initial-setup';

export class AppContext {
  readonly db: AppDatabase;
  readonly logger: Logger;
  readonly secrets: SecretStore;
  readonly mediaTools: MediaToolService;
  readonly places: PlaceService;
  readonly vision: VisionService;
  readonly footageVerification: FootageVerificationService;
  readonly providerPolicy: ProviderPolicyService;
  readonly providerEndpoints: ProviderEndpointPolicy;
  readonly research: ResearchService;
  readonly catalog: CatalogService;
  readonly catalogImports: CatalogImportWorkerService;
  readonly diagnostics: DiagnosticsService;
  readonly ai: AiService;
  readonly projects: ProjectService;
  readonly media: MediaService;
  readonly acquisitions: AcquisitionService;
  readonly jobs: JobService;
  readonly scriptFinalization: ScriptFinalizationService;
  readonly tts: TtsService;
  readonly narration: NarrationService;
  readonly renders: RenderService;
  readonly activeFinal: ActiveFinalService;
  readonly youtube: YouTubeService;
  readonly finalReview: FinalReviewService;
  readonly exceptions: ExceptionService;
  readonly ambiguousMappings: AmbiguousMappingService;
  readonly watcher: DownloadWatcher;
  readonly backups: BackupService;
  readonly artifacts: ProjectArtifactService;
  readonly settingsProfiles: SettingsProfileService;
  readonly updates: UpdateService;
  readonly scheduler: SchedulerService;
  readonly analytics: AnalyticsService;
  readonly music: MusicService;
  readonly storage: StorageService;
  readonly expansion: ExpansionService;
  readonly google: GoogleProviderService;
  readonly workflow: WorkflowService;
  readonly storyboard: StoryboardService;

  private settingsValue: AppSettings;
  private readonly longOperationPower = new LongOperationPowerGuard();
  private backupTimer?: NodeJS.Timeout;
  private backupStartupTimer?: NodeJS.Timeout;
  private catalogRefreshTimer?: NodeJS.Timeout;
  private updateCheckTimer?: NodeJS.Timeout;
  private schedulerTimer?: NodeJS.Timeout;
  private analyticsTimer?: NodeJS.Timeout;
  private storageTimer?: NodeJS.Timeout;
  private backgroundStartupTimer?: NodeJS.Timeout;
  private diagnosticsRefresh?: Promise<void>;
  private started = false;
  private backgroundServicesStarted = false;
  private startupStaleDerivativeCount = 0;
  private readonly operationGate = new OperationGate();
  private stopPromise?: Promise<void>;

  constructor(private readonly mainWindow: () => BrowserWindow | null) {
    const defaults = buildDefaultSettings();
    ensureSettingsPaths(defaults);
    BackupService.applyPendingRestore(defaults.databasePath);
    this.db = new AppDatabase(defaults.databasePath);
    this.settingsValue = normalizeLegacyProviderEndpointSettings(this.db.getAppSettings(defaults));
    ensureSettingsPaths(this.settingsValue);
    this.db.saveAppSettings(this.settingsValue);

    this.logger = new Logger(join(this.settingsValue.dataRoot, 'logs', 'videofactory.jsonl'));
    this.secrets = new SecretStore(join(app.getPath('userData'), 'secrets.vf'));
    this.mediaTools = new MediaToolService(
      this.db,
      () => this.settingsValue,
      (role, path) => this.setMediaToolOverride(role, path),
      app.getVersion(),
      app.isPackaged
    );
    this.mediaTools.quarantineLegacyOverrides();
    installMediaToolResolver(this.mediaTools);
    installProcessLaunchGuard(executable => this.mediaTools.guardLaunch(executable));
    this.providerEndpoints = new ProviderEndpointPolicy(
      this.db,
      this.secrets,
      () => this.settingsValue
    );
    this.places = new PlaceService(this.db);
    this.places.syncAssetsMissingAssertions();
    this.catalog = new CatalogService(this.db, this.places);
    this.catalogImports = new CatalogImportWorkerService(
      this.db.path,
      event => this.emitProgress(event)
    );
    this.jobs = new JobService(this.db);
    this.jobs.recoverInterrupted();
    this.exceptions = new ExceptionService(this.db);
    this.diagnostics = new DiagnosticsService(this.db, () => this.settingsValue, app.getVersion());
    this.providerPolicy = new ProviderPolicyService(this.db, () => this.settingsValue);
    this.ai = new AiService(
      this.db,
      this.secrets,
      () => this.settingsValue,
      this.providerPolicy,
      this.providerEndpoints
    );
    this.research = new ResearchService(
      this.db,
      this.secrets,
      () => this.settingsValue,
      this.providerEndpoints
    );
    this.vision = new VisionService(
      this.db,
      this.secrets,
      () => this.settingsValue,
      this.providerEndpoints
    );
    this.footageVerification = new FootageVerificationService(
      this.db,
      () => this.settingsValue,
      this.places,
      this.vision
    );
    this.projects = new ProjectService(
      this.db,
      this.catalog,
      this.ai,
      () => this.settingsValue,
      this.places,
      this.research,
      this.vision,
      () => this.productionSetupState()
    );
    this.jobs.setCheckpointHandler(projectId => {
      try {
        if (this.projects.applyPendingLifecycle(projectId)) this.emitState();
      } catch (error) {
        this.logger.error('Deferred project lifecycle request failed at job checkpoint', error);
      }
    });
    this.storyboard = new StoryboardService(
      this.db,
      this.projects,
      this.projects.repairs,
      this.places,
      this.footageVerification
    );
    this.scriptFinalization = new ScriptFinalizationService(
      this.db,
      () => this.settingsValue,
      this.ai,
      this.projects
    );
    this.tts = new TtsService(
      this.db,
      this.secrets,
      () => this.settingsValue,
      this.providerPolicy,
      this.providerEndpoints
    );
    this.narration = new NarrationService(
      this.db,
      () => this.settingsValue,
      this.tts,
      this.projects
    );
    this.media = new MediaService(
      this.db,
      () => this.settingsValue,
      this.footageVerification,
      (projectId, phase, progress, message) => {
        this.emitProgress({
          jobId: `media-${projectId ?? 'global'}`,
          projectId,
          type: 'media_ingest',
          progress,
          phase,
          message
        });
      },
      async projectId => {
        this.queueWorkflow(projectId);
      }
    );
    this.acquisitions = new AcquisitionService(this.db, this.media);
    this.ambiguousMappings = new AmbiguousMappingService(this.db, this.acquisitions);
    this.renders = new RenderService(
      this.db,
      () => this.settingsValue,
      this.jobs,
      this.projects,
      (jobId, projectId, progress, phase, message) => {
        this.emitProgress({ jobId, projectId, type: 'render', progress, phase, message });
      },
      async (projectId, targetState) => {
        await this.workflow.prepareRepairWithinRenderJob(projectId, targetState);
      }
    );
    this.renders.recoverInterrupted();
    this.activeFinal = new ActiveFinalService(this.db, () => this.settingsValue.outputFolder);
    this.youtube = new YouTubeService(
      this.db,
      () => this.settingsValue,
      this.secrets,
      this.projects,
      (projectId, progress, message) => {
        this.emitProgress({
          jobId: `youtube-${projectId}`,
          projectId,
          type: 'youtube_upload',
          progress,
          phase: 'upload',
          message
        });
      },
      undefined,
      undefined,
      undefined,
      this.activeFinal,
      undefined,
      this.providerPolicy
    );
    this.finalReview = new FinalReviewService(
      this.db,
      this.projects,
      () => this.settingsValue.projectFolder,
      this.activeFinal
    );
    this.workflow = new WorkflowService(
      this.db,
      this.jobs,
      this.projects,
      this.scriptFinalization,
      this.narration,
      this.renders,
      this.finalReview,
      this.youtube,
      () => this.emitState(),
      () => this.beginLongOperation()
    );
    this.backups = new BackupService(this.db, () => this.settingsValue);
    this.artifacts = new ProjectArtifactService(this.db, () => this.settingsValue);
    this.watcher = new DownloadWatcher(
      this.db,
      this.media,
      () => this.settingsValue,
      message => this.notify(message)
    );
    this.settingsProfiles = new SettingsProfileService(
      this.db,
      () => this.settingsValue,
      patch => this.updateSettings(patch),
      app.getVersion()
    );
    this.updates = new UpdateService(this.db, () => this.settingsValue, app.getVersion());
    this.scheduler = new SchedulerService(
      this.db,
      () => this.settingsValue,
      () => this.projects.createAutopilot({}),
      () => this.productionSetupState(),
      () => this.workflow.resumeOldest()
    );
    this.google = new GoogleProviderService(this.secrets);
    this.analytics = new AnalyticsService(
      this.db,
      () => this.settingsValue,
      patch => this.updateSettings(patch),
      this.google,
      this.jobs
    );
    this.music = new MusicService(this.db, () => this.settingsValue);
    this.storage = new StorageService(this.db, () => this.settingsValue);
    this.expansion = new ExpansionService(
      this.db,
      this.catalog,
      () => this.settingsValue,
      () => this.secrets.status(),
      this.catalogImports,
      this.google,
      provider => this.providerEndpoints.state(provider)
    );
  }

  setPowerBlockerHandler(handler: (active: boolean) => void): void {
    this.longOperationPower.setHandler(handler);
  }

  beginLongOperation(): () => void {
    return this.longOperationPower.begin();
  }

  runLongOperation<T>(work: () => T | Promise<T>): Promise<T> {
    return this.longOperationPower.run(work);
  }

  runOperation<T>(label: string, work: () => T | Promise<T>): Promise<T> {
    return this.operationGate.run(label, work);
  }

  pendingOperations(): ActiveOperation[] {
    return this.operationGate.snapshot();
  }

  acceptsOperations(): boolean {
    return this.operationGate.isAccepting;
  }

  settings(): AppSettings {
    return { ...this.settingsValue };
  }

  async updateSettings(patch: SettingsPatch): Promise<AppSettings> {
    if ('ffmpegPath' in patch || 'ffprobePath' in patch) {
      throw new Error('Media executable overrides require the dedicated inspect-and-trust flow.');
    }
    const next = { ...this.settingsValue, ...patch };
    if (next.databasePath !== this.settingsValue.databasePath) {
      throw new Error('Changing the active database path requires a controlled migration and is not supported in this alpha.');
    }
    this.providerEndpoints.validateSettings(next);
    ensureSettingsPaths(next);
    const healthToReset = new Set<string>();
    if (next.researchProvider !== this.settingsValue.researchProvider) healthToReset.add('tavily');
    if (next.llmProvider !== this.settingsValue.llmProvider) healthToReset.add('openai_compatible');
    if (next.visionProvider !== this.settingsValue.visionProvider) healthToReset.add('openai_compatible_vision');
    if (next.narratorProvider !== this.settingsValue.narratorProvider) healthToReset.add('http_tts');
    this.db.raw.transaction(() => {
      this.providerEndpoints.applySettingsChange(this.settingsValue, next);
      for (const provider of healthToReset) this.db.raw.prepare('DELETE FROM provider_health WHERE provider = ?').run(provider);
      this.db.saveAppSettings(next);
    })();
    this.settingsValue = next;
    this.providerEndpoints.refreshConfigurationHealth();
    if (this.operationGate.isAccepting) await this.watcher.start();
    if (this.started) this.startBackupScheduler();
    if (this.started) this.startOperationsSchedulers();
    this.refreshDiagnosticsInBackground();
    this.emitState();
    return this.settings();
  }

  private setMediaToolOverride(role: MediaToolRole, path: string): void {
    const key = role === 'ffmpeg' ? 'ffmpegPath' : 'ffprobePath';
    this.settingsValue = { ...this.settingsValue, [key]: path };
    this.db.saveAppSettings(this.settingsValue);
    this.refreshDiagnosticsInBackground();
    this.emitState();
  }

  updateSecrets(patch: Partial<Secrets>): SecretStatus {
    const status = this.secrets.update(patch);
    const providers: ProviderEndpointId[] = [
      ...(patch.researchApiKey !== undefined ? ['tavily' as const] : []),
      ...(patch.llmApiKey !== undefined ? ['openai_compatible' as const] : []),
      ...(patch.visionApiKey !== undefined ? ['openai_compatible_vision' as const] : []),
      ...(patch.httpTtsApiKey !== undefined ? ['http_tts' as const] : [])
    ];
    this.providerEndpoints.reconcileCredentialChanges(providers);
    this.emitState();
    return status;
  }

  queueSummary(): QueueSummary {
    const project = this.db.raw.prepare(`
      SELECT
        sum(CASE WHEN state NOT IN ('PUBLISHED','ANALYTICS_ACTIVE','FAILED','CANCELLED','ARCHIVED','PAUSED') THEN 1 ELSE 0 END) AS active,
        sum(CASE WHEN state = 'WAITING_FOR_DOWNLOADS' THEN 1 ELSE 0 END) AS downloads,
        sum(CASE WHEN state = 'WAITING_FINAL_APPROVAL' THEN 1 ELSE 0 END) AS approval
      FROM projects
    `).get() as Record<string, number | null>;
    const exceptions = this.db.raw.prepare(`
      SELECT count(*) AS count FROM exceptions WHERE status = 'OPEN'
    `).get() as { count: number };
    const jobs = this.db.raw.prepare(`
      SELECT
        sum(CASE WHEN state IN ('QUEUED','READY','RETRY_SCHEDULED') THEN 1 ELSE 0 END) AS queued,
        sum(CASE WHEN state = 'RUNNING' THEN 1 ELSE 0 END) AS running
      FROM jobs
    `).get() as Record<string, number | null>;
    return {
      activeProjects: Number(project.active ?? 0),
      waitingDownloads: Number(project.downloads ?? 0),
      waitingApproval: Number(project.approval ?? 0),
      openExceptions: exceptions.count,
      queuedJobs: Number(jobs.queued ?? 0),
      runningJobs: Number(jobs.running ?? 0)
    };
  }

  operationsHealth(): OperationsHealth {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const spend = this.db.raw.prepare(`
      SELECT coalesce(sum(estimated_cost_usd), 0) AS total
      FROM provider_calls WHERE created_at >= ?
    `).get(monthStart.toISOString()) as { total: number };
    const spentUsd = Number(spend.total);
    const limitUsd = this.settingsValue.monthlyBudgetUsd;
    let freeBytes: number | null = null;
    try {
      const stats = statfsSync(this.settingsValue.mediaLibraryFolder);
      freeBytes = stats.bavail * stats.bsize;
    } catch {
      freeBytes = null;
    }
    const minimumBytes = this.settingsValue.minFreeDiskGb * 1024 ** 3;
    const runningTypes = (this.db.raw.prepare(`SELECT type FROM jobs WHERE state = 'RUNNING' ORDER BY type`).all() as Array<{ type: string }>)
      .map(row => row.type);
    const activeStates = (this.db.raw.prepare(`
      SELECT state FROM projects
      WHERE state IN ('INGESTING_MEDIA','VERIFYING_FOOTAGE','RENDERING_DRAFT','RENDERING_FINAL','UPLOADING_PRIVATE','WAITING_YOUTUBE_PROCESSING')
    `).all() as Array<{ state: string }>).map(row => row.state);
    return classifyOperationsHealth({
      spentUsd,
      limitUsd,
      freeBytes,
      minimumBytes,
      providers: (this.db.raw.prepare(`
        SELECT provider, status, message, checked_at FROM provider_health ORDER BY provider
      `).all() as Array<{ provider: string; status: OperationsHealth['providers'][number]['status']; message: string | null; checked_at: string }>).map(row => ({
        provider: row.provider,
        status: row.status,
        message: row.message,
        checkedAt: row.checked_at
      })),
      runningTypes,
      activeProjectStates: activeStates
    });
  }

  async bootstrap(): Promise<AppBootstrap> {
    const snapshot = this.stateSnapshot();
    return {
      settings: this.settings(),
      secrets: this.secrets.status(),
      ...snapshot
    };
  }

  private productionSetupState(): InitialSetupState {
    return initialSetupState({
      settings: this.settings(),
      secrets: this.secrets.status(),
      ...this.stateSnapshot()
    });
  }

  stateSnapshot(): AppStateSnapshot {
    return {
      diagnostics: this.diagnostics.latest(),
      queue: this.queueSummary(),
      catalog: this.catalog.stats(),
      projects: this.projects.list(),
      exceptions: this.exceptions.list(undefined, true).slice(0, 20),
      latestCatalogRefresh: this.catalog.latestRefresh(),
      latestUpdateCheck: this.updates.latest(),
      scheduler: this.scheduler.status(),
      operationsHealth: this.operationsHealth(),
      providerEndpoints: this.providerEndpoints.states(),
      learningRecommendations: this.analytics.recommendations(),
      musicTracks: this.music.list(),
      latestStorageCleanup: this.storage.latest(),
      expansion: this.expansion.registry()
    };
  }

  emitProgress(event: ProgressEvent): void {
    this.mainWindow()?.webContents.send(IPC.progressEvent, event);
  }

  emitState(): void {
    this.mainWindow()?.webContents.send(IPC.stateEvent, this.stateSnapshot());
  }

  notify(message: string): void {
    if (Notification.isSupported()) {
      new Notification({ title: 'VideoFactory Desktop', body: message }).show();
    }
    this.emitState();
  }

  async start(): Promise<void> {
    const completedRestore = BackupService.consumeCompletedRestore(this.settingsValue.databasePath);
    if (completedRestore) {
      const reports = await this.artifacts.rebuildAllProjects();
      this.logger.info('Restore consistency and derivative rebuild completed', {
        completedRestore,
        projects: reports.map(report => ({ projectId: report.projectId, status: report.status }))
      });
      this.backups.recordCompletedRestoreRecovery(completedRestore, reports);
      BackupService.acknowledgeCompletedRestore(this.settingsValue.databasePath);
    }
    const runtimeStartedAt = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO audit_log(
        action, actor, entity_type, entity_id, after_json, metadata_json, created_at
      ) VALUES('application.runtime_started', 'system', 'application', ?, ?, ?, ?)
    `).run(
      app.getVersion(),
      JSON.stringify({
        packaged: app.isPackaged,
        appVersion: app.getVersion(),
        processId: process.pid,
        executablePathSha256: createHash('sha256')
          .update(resolve(process.execPath).toLowerCase())
          .digest('hex')
      }),
      JSON.stringify({ trigger: 'application_start' }),
      runtimeStartedAt
    );
    await this.watcher.start();
    const staleDerivativeCount = this.media.staleDerivativeCount();
    if (!staleDerivativeCount) await this.media.recoverPendingSemanticAlternates();
    this.startupStaleDerivativeCount = staleDerivativeCount;
    this.started = true;
  }

  startBackgroundServices(): void {
    if (!this.started || this.backgroundServicesStarted || !this.operationGate.isAccepting) return;
    this.backgroundServicesStarted = true;
    this.backgroundStartupTimer = setTimeout(() => {
      this.backgroundStartupTimer = undefined;
      if (!this.started || !this.operationGate.isAccepting) return;
      this.refreshDiagnosticsInBackground();
      if (this.startupStaleDerivativeCount) {
        this.runBackground(
          'media:refresh-stale-derivatives',
          async () => {
            const refreshed = await this.media.refreshStaleDerivatives();
            await this.media.recoverPendingSemanticAlternates();
            this.logger.info('Stale media derivatives regenerated', {
              refreshed,
              pipelineVersion: MediaService.PIPELINE_VERSION
            });
            await this.workflow.resumeOldest();
            this.emitState();
          },
          error => {
            this.logger.error('Stale media derivative regeneration failed closed', error);
            this.notify(`Media derivative regeneration failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        );
      } else {
        this.queueOldestWorkflow();
      }
      this.startBackupScheduler();
      this.startOperationsSchedulers();
    }, 1_000);
    this.backgroundStartupTimer.unref();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.started = false;
    this.operationGate.close();
    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    if (this.backgroundStartupTimer) clearTimeout(this.backgroundStartupTimer);
    if (this.backupStartupTimer) clearTimeout(this.backupStartupTimer);
    if (this.backupTimer) clearInterval(this.backupTimer);
    if (this.catalogRefreshTimer) clearInterval(this.catalogRefreshTimer);
    if (this.updateCheckTimer) clearInterval(this.updateCheckTimer);
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.analyticsTimer) clearInterval(this.analyticsTimer);
    if (this.storageTimer) clearInterval(this.storageTimer);
    const serviceStops = await Promise.allSettled([
      this.watcher.stop(),
      this.catalogImports.shutdown(),
      this.youtube.shutdown()
    ]);
    await this.operationGate.waitForIdle();
    installProcessLaunchGuard(null);
    installMediaToolResolver(null);
    const stopFailures = serviceStops.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (stopFailures.length) {
      throw new AggregateError(stopFailures, 'One or more application services could not stop safely.');
    }
    this.db.raw.prepare(`
      UPDATE catalog_imports
      SET status = 'cancelled', error = coalesce(error, 'Application closed during catalog import'),
          completed_at = coalesce(completed_at, ?)
      WHERE status = 'running'
    `).run(new Date().toISOString());
    this.db.checkpoint();
    this.db.close();
  }

  private startBackupScheduler(): void {
    if (this.backupStartupTimer) clearTimeout(this.backupStartupTimer);
    if (this.backupTimer) clearInterval(this.backupTimer);
    const sweep = (): void => {
      try {
        const backup = this.backups.createIfDue();
        if (backup) this.logger.info('Automatic backup completed', { path: backup.path, checksum: backup.checksum });
      } catch (error) {
        this.logger.error('Automatic backup failed', error);
        this.notify(`Automatic backup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    this.backupStartupTimer = setTimeout(sweep, 1_000);
    this.backupStartupTimer.unref();
    this.backupTimer = setInterval(sweep, 60 * 60 * 1_000);
    this.backupTimer.unref();
  }

  private refreshDiagnosticsInBackground(): void {
    if (!this.started || !this.operationGate.isAccepting || this.diagnostics.latest() || this.diagnosticsRefresh) return;
    const refresh = this.operationGate.run('background diagnostics', async () => {
      await this.diagnostics.run();
      this.emitState();
    })
      .catch(error => this.logger.error('Background system diagnostics failed', error))
      .finally(() => {
        if (this.diagnosticsRefresh === refresh) this.diagnosticsRefresh = undefined;
      });
    this.diagnosticsRefresh = refresh;
  }

  queueWorkflow(projectId: string): void {
    this.runBackground(
      `workflow:${projectId}`,
      () => this.workflow.advance(projectId),
      error => {
        this.logger.error('Automatic project continuation failed', { projectId, error });
        this.emitState();
      }
    );
  }

  private queueOldestWorkflow(): void {
    this.runBackground(
      'workflow:resume-oldest',
      () => this.workflow.resumeOldest(),
      error => {
        this.logger.error('Automatic startup continuation failed', error);
        this.emitState();
      }
    );
  }

  private runBackground<T>(label: string, work: () => Promise<T>, onError: (error: unknown) => void): void {
    if (!this.started || !this.operationGate.isAccepting) return;
    void this.operationGate.run(label, work).catch(onError);
  }

  private startOperationsSchedulers(): void {
    if (this.catalogRefreshTimer) clearInterval(this.catalogRefreshTimer);
    if (this.updateCheckTimer) clearInterval(this.updateCheckTimer);
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.analyticsTimer) clearInterval(this.analyticsTimer);
    if (this.storageTimer) clearInterval(this.storageTimer);
    const refreshCatalog = (): void => {
      const settings = this.settingsValue;
      if (!settings.catalogRefreshEnabled || !settings.catalogImportFile) return;
      const latest = this.catalog.latestRefresh();
      const intervalMs = settings.catalogRefreshIntervalHours * 60 * 60 * 1_000;
      if (latest && Date.now() - Date.parse(latest.createdAt) < intervalMs) return;
      this.runBackground('catalog:scheduled-refresh', () => this.runLongOperation(async () => {
        const run = await this.catalogImports.refresh(randomUUID(), {
          filePath: settings.catalogImportFile,
          templateId: settings.catalogValidationTemplateId
        });
        if (run.status === 'staged') this.notify('A scheduled catalog refresh diff is staged for review.');
        if (run.status === 'blocked' || run.status === 'failed') {
          this.notify(`Scheduled catalog refresh ${run.status}: ${run.validation.issues[0] ?? run.error ?? 'Review required.'}`);
        }
      }), error => this.logger.error('Scheduled catalog refresh failed', error));
    };
    const checkUpdates = (): void => {
      if (!this.settingsValue.updateCheckEnabled) return;
      const latest = this.updates.latest();
      if (latest && Date.now() - Date.parse(latest.checkedAt) < 24 * 60 * 60 * 1_000) return;
      this.runBackground('updates:scheduled-check', async () => {
        const result = await this.updates.check();
        if (result.available) this.notify(`VideoFactory ${result.latestVersion} is available.`);
      }, error => this.logger.error('Application update check failed', error));
    };
    const runScheduler = (): void => {
      this.runBackground('scheduler:evaluate', async () => {
        const status = await this.scheduler.evaluate('timer');
        if (status.state === 'blocked') this.logger.info('Autopilot scheduler paused by a recoverable gate', status);
        this.emitState();
      }, error => this.logger.error('Autopilot scheduler evaluation failed', error));
    };
    const cleanupStorage = (): void => {
      if (!this.settingsValue.automaticDerivativeCleanup) return;
      try {
        const report = this.storage.cleanup({ trigger: 'disk_pressure' });
        if (report.removedCount) this.logger.info('Regenerable derivative cleanup completed', report);
      } catch (error) {
        this.logger.error('Regenerable derivative cleanup failed', error);
      }
    };
    const runAnalytics = (): void => {
      this.runBackground('analytics:scheduled-checkpoints', async () => {
        const result = await this.analytics.processDue();
        if (result.dueJobs || result.succeeded || result.deferred || result.failed) {
          this.logger.info('Analytics checkpoint sweep completed', result);
          this.emitState();
        }
      }, error => this.logger.error('Analytics checkpoint sweep failed', error));
    };
    refreshCatalog();
    checkUpdates();
    runAnalytics();
    this.runBackground(
      'scheduler:startup',
      async () => {
        await this.scheduler.evaluate('startup');
        this.emitState();
      },
      error => this.logger.error('Autopilot scheduler startup evaluation failed', error)
    );
    this.catalogRefreshTimer = setInterval(refreshCatalog, 60 * 60 * 1_000);
    this.catalogRefreshTimer.unref();
    this.updateCheckTimer = setInterval(checkUpdates, 6 * 60 * 60 * 1_000);
    this.updateCheckTimer.unref();
    this.schedulerTimer = setInterval(runScheduler, 15 * 60 * 1_000);
    this.schedulerTimer.unref();
    this.analyticsTimer = setInterval(runAnalytics, 60 * 60 * 1_000);
    this.analyticsTimer.unref();
    this.storageTimer = setInterval(cleanupStorage, 6 * 60 * 60 * 1_000);
    this.storageTimer.unref();
  }
}
