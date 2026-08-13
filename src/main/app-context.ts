import { app, BrowserWindow, Notification } from 'electron';
import { join } from 'node:path';
import type { AppSettings, AppBootstrap, QueueSummary, ProgressEvent } from '@shared/types';
import { buildDefaultSettings, ensureSettingsPaths } from './app-paths';
import { AppDatabase } from './database/database';
import { Logger } from './logger';
import { SecretStore } from './secret-store';
import { CatalogService } from './services/catalog-service';
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
import { BackupService } from './services/backup-service';
import { IPC } from '@shared/ipc-channels';
import { PlaceService } from './services/place-service';
import { VisionService } from './services/vision-service';
import { FootageVerificationService } from './services/footage-verification-service';
import { ResearchService } from './services/research-service';
import { ProviderPolicyService } from './services/provider-policy';
import { ScriptFinalizationService } from './services/script-finalization-service';
import { NarrationService } from './services/narration-service';

export class AppContext {
  readonly db: AppDatabase;
  readonly logger: Logger;
  readonly secrets: SecretStore;
  readonly places: PlaceService;
  readonly vision: VisionService;
  readonly footageVerification: FootageVerificationService;
  readonly providerPolicy: ProviderPolicyService;
  readonly research: ResearchService;
  readonly catalog: CatalogService;
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
  readonly youtube: YouTubeService;
  readonly finalReview: FinalReviewService;
  readonly exceptions: ExceptionService;
  readonly watcher: DownloadWatcher;
  readonly backups: BackupService;

  private settingsValue: AppSettings;
  private powerBlockerChanged?: (active: boolean) => void;
  private backupTimer?: NodeJS.Timeout;
  private backupStartupTimer?: NodeJS.Timeout;
  private started = false;

  constructor(private readonly mainWindow: () => BrowserWindow | null) {
    const defaults = buildDefaultSettings();
    ensureSettingsPaths(defaults);
    BackupService.applyPendingRestore(defaults.databasePath);
    this.db = new AppDatabase(defaults.databasePath);
    this.settingsValue = this.db.getAppSettings(defaults);
    ensureSettingsPaths(this.settingsValue);
    this.db.saveAppSettings(this.settingsValue);

    this.logger = new Logger(join(this.settingsValue.dataRoot, 'logs', 'videofactory.jsonl'));
    this.secrets = new SecretStore(join(app.getPath('userData'), 'secrets.vf'));
    this.places = new PlaceService(this.db);
    this.places.syncAssetsMissingAssertions();
    this.catalog = new CatalogService(this.db, this.places);
    this.jobs = new JobService(this.db);
    this.jobs.recoverInterrupted();
    this.exceptions = new ExceptionService(this.db);
    this.diagnostics = new DiagnosticsService(this.db, () => this.settingsValue, app.getVersion());
    this.providerPolicy = new ProviderPolicyService(this.db, () => this.settingsValue);
    this.ai = new AiService(this.db, this.secrets, () => this.settingsValue, this.providerPolicy);
    this.research = new ResearchService(this.db, this.secrets, () => this.settingsValue);
    this.vision = new VisionService(this.db, this.secrets, () => this.settingsValue);
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
      this.vision
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
      this.providerPolicy
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
        await this.scriptFinalization.finalize(projectId);
        await this.narration.generate(projectId);
      }
    );
    this.acquisitions = new AcquisitionService(this.db, this.media);
    this.renders = new RenderService(
      this.db,
      () => this.settingsValue,
      this.jobs,
      this.projects,
      (jobId, projectId, progress, phase, message) => {
        this.emitProgress({ jobId, projectId, type: 'render', progress, phase, message });
      },
      async (projectId, targetState) => {
        if (targetState === 'FINALIZING_SCRIPT') {
          await this.scriptFinalization.finalize(projectId);
          await this.narration.generate(projectId);
        } else if (targetState === 'GENERATING_VOICE') {
          await this.narration.generate(projectId);
        }
      }
    );
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
      }
    );
    this.finalReview = new FinalReviewService(this.db, this.projects);
    this.backups = new BackupService(this.db, () => this.settingsValue);
    this.watcher = new DownloadWatcher(
      this.db,
      this.media,
      () => this.settingsValue,
      message => this.notify(message)
    );
  }

  setPowerBlockerHandler(handler: (active: boolean) => void): void {
    this.powerBlockerChanged = handler;
  }

  setLongOperationActive(active: boolean): void {
    this.powerBlockerChanged?.(active);
  }

  settings(): AppSettings {
    return { ...this.settingsValue };
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = { ...this.settingsValue, ...patch };
    if (next.databasePath !== this.settingsValue.databasePath) {
      throw new Error('Changing the active database path requires a controlled migration and is not supported in this alpha.');
    }
    ensureSettingsPaths(next);
    const healthToReset = new Set<string>();
    if (next.researchProvider !== this.settingsValue.researchProvider || next.researchBaseUrl !== this.settingsValue.researchBaseUrl) healthToReset.add('tavily');
    if (next.llmProvider !== this.settingsValue.llmProvider || next.llmBaseUrl !== this.settingsValue.llmBaseUrl) healthToReset.add('openai_compatible');
    if (next.visionProvider !== this.settingsValue.visionProvider || next.visionBaseUrl !== this.settingsValue.visionBaseUrl) healthToReset.add('openai_compatible_vision');
    if (next.narratorProvider !== this.settingsValue.narratorProvider || next.narratorBaseUrl !== this.settingsValue.narratorBaseUrl) healthToReset.add('http_tts');
    if (next.narratorProvider === 'http_tts' && !this.secrets.getAll().httpTtsApiKey) {
      throw new Error('HTTP TTS cannot be enabled until its encrypted API key is configured.');
    }
    for (const provider of healthToReset) this.db.raw.prepare('DELETE FROM provider_health WHERE provider = ?').run(provider);
    this.settingsValue = next;
    this.db.saveAppSettings(next);
    await this.watcher.start();
    if (this.started) this.startBackupScheduler();
    this.emitState();
    return this.settings();
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

  async bootstrap(): Promise<AppBootstrap> {
    return {
      settings: this.settings(),
      secrets: this.secrets.status(),
      diagnostics: await this.diagnostics.run(),
      queue: this.queueSummary(),
      catalog: this.catalog.stats(),
      projects: this.projects.list(),
      exceptions: this.exceptions.list(undefined, true).slice(0, 20)
    };
  }

  emitProgress(event: ProgressEvent): void {
    this.mainWindow()?.webContents.send(IPC.progressEvent, event);
  }

  emitState(): void {
    this.mainWindow()?.webContents.send(IPC.stateEvent, {
      queue: this.queueSummary(),
      catalog: this.catalog.stats(),
      projects: this.projects.list(),
      exceptions: this.exceptions.list(undefined, true).slice(0, 20)
    });
  }

  notify(message: string): void {
    if (Notification.isSupported()) {
      new Notification({ title: 'VideoFactory Desktop', body: message }).show();
    }
    this.emitState();
  }

  async start(): Promise<void> {
    await this.watcher.start();
    await this.media.recoverPendingSemanticAlternates();
    this.started = true;
    this.startBackupScheduler();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.backupStartupTimer) clearTimeout(this.backupStartupTimer);
    if (this.backupTimer) clearInterval(this.backupTimer);
    await this.watcher.stop();
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
}
