import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type {
  AppBootstrap,
  AppSettings,
  CatalogImportPreview,
  CatalogImportResult,
  CatalogSearchRequest,
  CatalogSearchResult,
  CatalogStats,
  CoverageCluster,
  CreateAutopilotProjectRequest,
  DiagnosticsReport,
  ExceptionRecord,
  FinalReview,
  JobRecord,
  ProgressEvent,
  ProjectDetail,
  ProjectSummary,
  RenderRecord,
  SecretStatus,
  YouTubeConnectionStatus
} from '@shared/types';

const api = {
  app: {
    bootstrap: (): Promise<AppBootstrap> => ipcRenderer.invoke(IPC.bootstrap),
    onProgress: (listener: (event: ProgressEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: ProgressEvent): void => listener(value);
      ipcRenderer.on(IPC.progressEvent, handler);
      return () => ipcRenderer.removeListener(IPC.progressEvent, handler);
    },
    onState: (listener: (value: unknown) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(value);
      ipcRenderer.on(IPC.stateEvent, handler);
      return () => ipcRenderer.removeListener(IPC.stateEvent, handler);
    }
  },
  diagnostics: {
    run: (): Promise<DiagnosticsReport> => ipcRenderer.invoke(IPC.diagnosticsRun)
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    updateSecrets: (patch: Record<string, string | undefined>): Promise<SecretStatus> =>
      ipcRenderer.invoke(IPC.secretsUpdate, patch),
    choosePath: (request: { kind: 'directory' | 'file'; title?: string; filters?: Electron.FileFilter[] }): Promise<string | null> =>
      ipcRenderer.invoke(IPC.pathsChoose, request)
  },
  catalog: {
    chooseImport: (): Promise<CatalogImportPreview | null> => ipcRenderer.invoke(IPC.catalogChooseImport),
    previewImport: (request: { filePath: string; sheetName?: string }): Promise<CatalogImportPreview> =>
      ipcRenderer.invoke(IPC.catalogPreviewImport, request),
    commitImport: (request: {
      filePath: string;
      sheetName?: string;
      mapping?: Record<string, string | null>;
    }): Promise<CatalogImportResult> => ipcRenderer.invoke(IPC.catalogCommitImport, request),
    search: (request: CatalogSearchRequest): Promise<CatalogSearchResult> =>
      ipcRenderer.invoke(IPC.catalogSearch, request),
    stats: (): Promise<CatalogStats> => ipcRenderer.invoke(IPC.catalogStats),
    coverage: (limit = 100): Promise<CoverageCluster[]> => ipcRenderer.invoke(IPC.catalogCoverage, limit),
    updateAsset: (request: {
      assetId: string;
      patch: Record<string, unknown>;
      reason?: string;
    }) => ipcRenderer.invoke(IPC.catalogUpdateAsset, request)
  },
  projects: {
    list: (): Promise<ProjectSummary[]> => ipcRenderer.invoke(IPC.projectsList),
    get: (projectId: string): Promise<ProjectDetail> => ipcRenderer.invoke(IPC.projectGet, projectId),
    createAutopilot: (request: CreateAutopilotProjectRequest): Promise<ProjectDetail> =>
      ipcRenderer.invoke(IPC.projectCreateAutopilot, request),
    advance: (projectId: string) => ipcRenderer.invoke(IPC.projectAdvance, projectId),
    remove: (projectId: string): Promise<boolean> => ipcRenderer.invoke(IPC.projectDelete, projectId)
  },
  acquisitions: {
    list: (projectId?: string) => ipcRenderer.invoke(IPC.acquisitionList, projectId),
    activate: (id: string) => ipcRenderer.invoke(IPC.acquisitionActivate, id),
    open: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.acquisitionOpen, id),
    attest: (request: { acquisitionId: string; certificatePath?: string }) =>
      ipcRenderer.invoke(IPC.acquisitionAttest, request),
    mapFile: (request: { acquisitionId: string; filePath?: string }): Promise<boolean> =>
      ipcRenderer.invoke(IPC.acquisitionMapFile, request)
  },
  renders: {
    start: (request: { projectId: string; kind: 'draft' | 'final' }): Promise<RenderRecord> =>
      ipcRenderer.invoke(IPC.renderStart, request)
  },
  finalReview: {
    get: (projectId: string): Promise<FinalReview> => ipcRenderer.invoke(IPC.finalReviewGet, projectId),
    selectPackage: (request: { projectId: string; packageId: string }): Promise<FinalReview> =>
      ipcRenderer.invoke(IPC.packagingSelect, request)
  },
  youtube: {
    status: (): Promise<YouTubeConnectionStatus> => ipcRenderer.invoke(IPC.youtubeStatus),
    authorize: (): Promise<YouTubeConnectionStatus> => ipcRenderer.invoke(IPC.youtubeAuthorize),
    uploadPrivate: (projectId: string): Promise<{ videoId: string; url: string }> =>
      ipcRenderer.invoke(IPC.youtubeUploadPrivate, projectId),
    approve: (request: {
      projectId: string;
      action: 'keep_private' | 'publish' | 'schedule';
      scheduledAt?: string;
    }): Promise<boolean> => ipcRenderer.invoke(IPC.youtubeApprove, request)
  },
  exceptions: {
    list: (request?: { projectId?: string; openOnly?: boolean }): Promise<ExceptionRecord[]> =>
      ipcRenderer.invoke(IPC.exceptionsList, request),
    resolve: (request: { id: string; resolution?: Record<string, unknown> }): Promise<ExceptionRecord> =>
      ipcRenderer.invoke(IPC.exceptionResolve, request)
  },
  jobs: {
    list: (projectId?: string): Promise<JobRecord[]> => ipcRenderer.invoke(IPC.jobsList, projectId),
    retry: (id: string): Promise<JobRecord> => ipcRenderer.invoke(IPC.jobsRetry, id)
  },
  system: {
    openPath: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.mediaOpenPath, path),
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC.externalOpen, url)
  }
};

contextBridge.exposeInMainWorld('videoFactory', api);

export type VideoFactoryApi = typeof api;
