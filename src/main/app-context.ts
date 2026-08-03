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
import { IPC } from '@shared/ipc-channels';

export class AppContext {
  readonly db: AppDatabase;
  readonly logger: Logger;
  readonly secrets: SecretStore;
  readonly catalog: CatalogService;
  readonly diagnostics: DiagnosticsService;
  readonly ai: AiService;
  readonly projects: ProjectService;
  readonly media: MediaService;
  readonly acquisitions: AcquisitionService;
  readonly jobs: JobService;
  readonly tts: TtsService;
  readonly renders: RenderService;
  readonly youtube: YouTubeService;
  readonly finalReview: FinalReviewService;
  readonly exceptions: ExceptionService;
  readonly watcher: DownloadWatcher;

  private settingsValue: AppSettings;

  constructor(private readonly mainWindow: () => BrowserWindow | null) {
    const defaults = buildDefaultSettings();
    ensureSettingsPaths(defaults);
    this.db = new AppDatabase(defaults.databasePath);
    this.settingsValue = this.db.getAppSettings(defaults);
    ensureSettingsPaths(this.settingsValue);
    this.db.saveAppSettings(this.settingsValue);

    this.logger = new Logger(join(this.settingsValue.dataRoot, 'logs', 'videofactory.jsonl'));
    this.secrets = new SecretStore(join(app.getPath('userData'), 'secrets.vf'));
    this.catalog = new CatalogService(this.db);
    this.jobs = new JobService(this.db);
    this.jobs.recoverInterrupted();
    this.exceptions = new ExceptionService(this.db);
    this.diagnostics = new DiagnosticsService(this.db, () => this.settingsValue, app.getVersion());
    this.ai = new AiService(this.db, this.secrets, () => this.settingsValue);
    this.projects = new ProjectService(this.db, this.catalog, this.ai, () => this.settingsValue);
    this.media = new MediaService(
      this.db,
      () => this.settingsValue,
      (projectId, phase, progress, message) => {
        this.emitProgress({
          jobId: `media-${projectId ?? 'global'}`,
          projectId,
          type: 'media_ingest',
          progress,
          phase,
          message
        });
      }
    );
    this.acquisitions = new AcquisitionService(this.db, this.media);
    this.tts = new TtsService(() => this.settingsValue);
    this.renders = new RenderService(
      this.db,
      () => this.settingsValue,
      this.tts,
      this.jobs,
      this.projects,
      (jobId, projectId, progress, phase, message) => {
        this.emitProgress({ jobId, projectId, type: 'render', progress, phase, message });
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
    this.finalReview = new FinalReviewService(this.projects);
    this.watcher = new DownloadWatcher(
      this.db,
      this.media,
      () => this.settingsValue,
      message => this.notify(message)
    );
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
    this.settingsValue = next;
    this.db.saveAppSettings(next);
    await this.watcher.start();
    this.emitState();
    return this.settings();
  }

  queueSummary(): QueueSummary {
    const project = this.db.raw.prepare(`
      SELECT
        sum(CASE WHEN state NOT IN ('PUBLISHED','FAILED','PAUSED') THEN 1 ELSE 0 END) AS active,
        sum(CASE WHEN state = 'WAITING_FOR_DOWNLOADS' THEN 1 ELSE 0 END) AS downloads,
        sum(CASE WHEN state = 'WAITING_FINAL_APPROVAL' THEN 1 ELSE 0 END) AS approval
      FROM projects
    `).get() as Record<string, number | null>;
    const exceptions = this.db.raw.prepare(`
      SELECT count(*) AS count FROM exceptions WHERE status = 'OPEN'
    `).get() as { count: number };
    const jobs = this.db.raw.prepare(`
      SELECT
        sum(CASE WHEN state IN ('QUEUED','RETRY_WAIT') THEN 1 ELSE 0 END) AS queued,
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
  }

  async stop(): Promise<void> {
    await this.watcher.stop();
    this.db.close();
  }
}
