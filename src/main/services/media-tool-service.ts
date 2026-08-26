import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { AppDatabase } from '../database/database';
import { PrivilegedOperationError, rejectPrivilegedOperation } from '../security-events';
import type {
  AppSettings,
  MediaToolInspection,
  MediaToolRole,
  MediaToolSignature,
  MediaToolSource,
  MediaToolState,
  MediaToolTrustRequest,
  MediaToolTrustStatus
} from '@shared/types';
import {
  bundledMediaToolPath,
  developmentPathMediaTool,
  type MediaToolPathResolver
} from '../tool-paths';
import { runProcess } from './process-utils';

interface TrustRow {
  role: MediaToolRole;
  configured_path: string;
  canonical_path: string | null;
  sha256: string | null;
  size_bytes: number | null;
  signature_status: MediaToolSignature['status'];
  signature_subject: string | null;
  status: 'confirmation_required' | 'trusted' | 'changed' | 'missing' | 'role_mismatch' | 'probe_failed' | 'revoked';
  trusted_at: string | null;
  trusted_app_version: string | null;
  version_output: string | null;
  probed_at: string | null;
  updated_at: string;
}

interface PlatformSignature extends MediaToolSignature {
  originalFilename: string | null;
}

interface LaunchAuthorization {
  role: MediaToolRole;
  source: Exclude<MediaToolSource, 'unavailable'> | 'trust_probe';
  canonicalPath: string;
  sha256: string;
}

type MediaToolSecurityCode =
  | 'MEDIA_TOOL_ACK_REQUIRED'
  | 'MEDIA_TOOL_TRUST_IN_PROGRESS'
  | 'MEDIA_TOOL_IDENTITY_CHANGED'
  | 'MEDIA_TOOL_ROLE_MISMATCH'
  | 'MEDIA_TOOL_NOT_EXECUTABLE'
  | 'MEDIA_TOOL_SIGNATURE_INVALID'
  | 'MEDIA_TOOL_PROBE_FAILED'
  | 'MEDIA_TOOL_PATH_INVALID'
  | 'MEDIA_TOOL_MISSING'
  | 'MEDIA_TOOL_NOT_FILE'
  | 'MEDIA_TOOL_LINK_UNRESOLVED'
  | 'MEDIA_TOOL_EMPTY'
  | 'MEDIA_TOOL_INSPECTION_FAILED'
  | 'MEDIA_TOOL_TRUST_MISMATCH'
  | 'MEDIA_TOOL_HASH_CHANGED';

class MediaToolInspectionError extends Error {
  constructor(
    readonly code: MediaToolSecurityCode,
    message: string,
    readonly recovery: string
  ) {
    super(message);
    this.name = 'MediaToolInspectionError';
  }
}

function detectedRole(path: string, originalFilename: string | null = null): MediaToolRole | 'unknown' {
  for (const candidate of [originalFilename, basename(path)]) {
    const normalized = candidate?.trim().toLowerCase().replace(/\.exe$/i, '');
    if (normalized === 'ffmpeg' || normalized === 'ffprobe') return normalized;
  }
  return 'unknown';
}

function sha256File(path: string): string {
  const digest = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    closeSync(descriptor);
  }
  return digest.digest('hex');
}

function executableAccess(path: string): boolean {
  try {
    accessSync(path, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function cleanVersionOutput(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
    ?.slice(0, 1_000) ?? '';
}

export class MediaToolService implements MediaToolPathResolver {
  private readonly launchAuthorizations = new Map<string, LaunchAuthorization>();
  private readonly pendingProbes = new Map<string, LaunchAuthorization>();
  private readonly trustingRoles = new Set<MediaToolRole>();

  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly saveOverride: (role: MediaToolRole, path: string) => void,
    private readonly appVersion: string,
    private readonly packaged: boolean
  ) {}

  quarantineLegacyOverrides(): void {
    for (const role of ['ffmpeg', 'ffprobe'] as const) {
      const configuredPath = this.configuredPath(role).trim();
      if (!configuredPath || this.row(role)) continue;
      try {
        const inspection = this.inspectFile(role, configuredPath, {
          status: 'unavailable',
          subject: null,
          originalFilename: null
        });
        this.saveInspection(inspection, 'confirmation_required');
      } catch {
        this.saveUnavailable(role, configuredPath, 'missing');
      }
      this.audit('media_tool.legacy_override_quarantined', role, {
        status: this.row(role)?.status ?? 'confirmation_required'
      });
    }
  }

  list(): MediaToolState[] {
    return [this.state('ffmpeg'), this.state('ffprobe')];
  }

  state(role: MediaToolRole): MediaToolState {
    const configuredPath = this.configuredPath(role).trim();
    const bundled = bundledMediaToolPath(role);

    if (this.packaged && bundled) {
      if (configuredPath && !this.sameCanonicalPath(configuredPath, bundled)) {
        const custom = this.customState(role, configuredPath);
        const fallbackState = this.availableState(
          role,
          'bundled',
          custom.status,
          configuredPath,
          bundled,
          `${custom.message} The packaged, application-managed binary is active instead.`
        );
        return {
          ...fallbackState,
          canonicalPath: custom.canonicalPath,
          sha256: custom.sha256,
          hashPrefix: custom.hashPrefix,
          sizeBytes: custom.sizeBytes,
          executableByCurrentUser: custom.executableByCurrentUser,
          signature: custom.signature,
          trustedAt: custom.trustedAt,
          trustedAppVersion: custom.trustedAppVersion,
          version: custom.version
        };
      }
      return this.availableState(role, 'bundled', 'bundled', configuredPath, bundled,
        'The packaged, application-managed binary is active.');
    }

    if (configuredPath) {
      if (bundled && this.sameCanonicalPath(configuredPath, bundled)) {
        return this.availableState(role, 'bundled', 'bundled', configuredPath, bundled,
          'The configured path resolves to the application-managed binary.');
      }
      const custom = this.customState(role, configuredPath);
      if (custom.status === 'trusted') return custom;
      const fallback = bundled ?? developmentPathMediaTool(role);
      if (fallback) {
        const source: MediaToolSource = bundled ? 'bundled' : 'path_fallback';
        const fallbackState = this.availableState(
          role,
          source,
          custom.status,
          configuredPath,
          fallback,
          `${custom.message} ${bundled ? 'The bundled binary' : 'A visible development PATH fallback'} is active instead.`
        );
        return {
          ...fallbackState,
          canonicalPath: custom.canonicalPath,
          sha256: custom.sha256,
          hashPrefix: custom.hashPrefix,
          sizeBytes: custom.sizeBytes,
          executableByCurrentUser: custom.executableByCurrentUser,
          signature: custom.signature,
          trustedAt: custom.trustedAt,
          trustedAppVersion: custom.trustedAppVersion,
          version: custom.version
        };
      }
      return custom;
    }

    if (bundled) {
      return this.availableState(role, 'bundled', 'bundled', '', bundled,
        'The application-managed binary is active.');
    }
    const pathFallback = developmentPathMediaTool(role);
    if (pathFallback) {
      return this.availableState(role, 'path_fallback', 'development_fallback', '', pathFallback,
        'Development-only PATH discovery is active and is never used by a packaged build.');
    }
    return this.emptyState(role, '', 'unavailable', 'No safe executable is available.');
  }

  resolvePath(role: MediaToolRole, _configuredPath?: string): string | null {
    const state = this.state(role);
    if (!state.executablePath || state.source === 'unavailable' || !state.sha256) return null;
    const canonicalPath = realpathSync.native(state.executablePath);
    this.launchAuthorizations.set(canonicalPath, {
      role,
      source: state.source,
      canonicalPath,
      sha256: state.source === 'custom'
        ? (this.row(role)?.sha256 ?? state.sha256)
        : sha256File(canonicalPath)
    });
    return canonicalPath;
  }

  async inspect(role: MediaToolRole, path: string): Promise<MediaToolInspection> {
    try {
      const initial = this.inspectFile(role, path, {
        status: 'unavailable',
        subject: null,
        originalFilename: null
      });
      const signature = await this.inspectPlatformSignature(initial.canonicalPath);
      const inspection = this.inspectFile(role, path, signature);
      this.saveInspection(inspection, inspection.roleMatches ? 'confirmation_required' : 'role_mismatch');
      this.audit('media_tool.inspected', role, {
        detectedRole: inspection.detectedRole,
        roleMatches: inspection.roleMatches,
        executableByCurrentUser: inspection.executableByCurrentUser,
        hashPrefix: inspection.sha256.slice(0, 12),
        signatureStatus: inspection.signature.status
      });
      return inspection;
    } catch (error) {
      const known = error instanceof MediaToolInspectionError ? error : null;
      return this.reject(
        role,
        'inspection.path_validation',
        known?.code ?? 'MEDIA_TOOL_INSPECTION_FAILED',
        known?.message ?? 'The media tool could not be inspected safely.',
        known?.recovery ?? 'Verify the executable permissions and select the file again.',
        { errorType: error instanceof Error ? error.name : 'UnknownError' }
      );
    }
  }

  async trust(request: MediaToolTrustRequest): Promise<MediaToolState> {
    if (request.acknowledgePermissions !== true) {
      this.reject(
        request.role,
        'trust.permission_acknowledgement',
        'MEDIA_TOOL_ACK_REQUIRED',
        'Explicit executable-permission acknowledgement is required.',
        'Review the executable identity and explicitly acknowledge local execution permission.'
      );
    }
    if (this.trustingRoles.has(request.role)) {
      this.reject(
        request.role,
        'trust.concurrent_change',
        'MEDIA_TOOL_TRUST_IN_PROGRESS',
        `A ${request.role} trust operation is already in progress.`,
        'Wait for the current inspection and trust operation to finish before retrying.'
      );
    }
    this.trustingRoles.add(request.role);
    try {
      return await this.completeTrust(request);
    } finally {
      this.trustingRoles.delete(request.role);
    }
  }

  private async completeTrust(request: MediaToolTrustRequest): Promise<MediaToolState> {
    const inspection = await this.inspect(request.role, request.path);
    if (inspection.sha256 !== request.expectedSha256) {
      this.markStatus(request.role, 'changed');
      this.reject(
        request.role,
        'trust.identity_check',
        'MEDIA_TOOL_IDENTITY_CHANGED',
        'The executable changed after inspection. Inspect it again before trusting it.',
        'Inspect the executable again and explicitly confirm its new identity.',
        { observedHashPrefix: inspection.sha256.slice(0, 12) }
      );
    }
    if (!inspection.roleMatches) {
      this.markStatus(request.role, 'role_mismatch');
      this.reject(
        request.role,
        'trust.role_check',
        'MEDIA_TOOL_ROLE_MISMATCH',
        `The selected file does not identify as ${request.role}.`,
        `Select an executable that identifies itself as ${request.role}, then inspect it again.`,
        { detectedRole: inspection.detectedRole }
      );
    }
    if (!inspection.executableByCurrentUser) {
      this.markStatus(request.role, 'probe_failed');
      this.reject(
        request.role,
        'trust.permission_check',
        'MEDIA_TOOL_NOT_EXECUTABLE',
        'The selected file is not executable by the current user.',
        'Correct the file permissions or select an executable available to the current user.'
      );
    }
    if (inspection.signature.status === 'invalid') {
      this.markStatus(request.role, 'probe_failed');
      this.reject(
        request.role,
        'trust.signature_check',
        'MEDIA_TOOL_SIGNATURE_INVALID',
        'The selected file has an invalid platform signature and cannot be trusted.',
        'Replace the file with an authentic executable and inspect the replacement.'
      );
    }

    const probeAuthorization: LaunchAuthorization = {
      role: request.role,
      source: 'trust_probe',
      canonicalPath: inspection.canonicalPath,
      sha256: inspection.sha256
    };
    this.pendingProbes.set(probeAuthorization.canonicalPath, probeAuthorization);
    let version = '';
    try {
      const result = await runProcess(inspection.canonicalPath, ['-hide_banner', '-version'], { timeoutMs: 5_000 });
      version = cleanVersionOutput(result.stdout, result.stderr);
      if (result.code !== 0 || !version.toLowerCase().includes(`${request.role} version`)) {
        throw new Error(version || `${request.role} version probe exited with code ${result.code}.`);
      }
      if (sha256File(inspection.canonicalPath) !== inspection.sha256) {
        throw new Error('The executable changed during its version probe.');
      }
    } catch (error) {
      this.saveInspection(inspection, 'probe_failed', {
        versionOutput: null,
        probedAt: new Date().toISOString()
      });
      this.audit('media_tool.trust_probe_failed', request.role, {
        hashPrefix: inspection.sha256.slice(0, 12),
        reason: 'bounded_version_probe_failed',
        errorType: error instanceof Error ? error.name : 'UnknownError'
      });
      if (error instanceof PrivilegedOperationError) throw error;
      this.reject(
        request.role,
        'trust.version_probe',
        'MEDIA_TOOL_PROBE_FAILED',
        `The ${request.role} trust probe failed safely.`,
        'Verify the executable is authentic and runnable, then inspect and trust it again.',
        {
          hashPrefix: inspection.sha256.slice(0, 12),
          signatureStatus: inspection.signature.status,
          errorType: error instanceof Error ? error.name : 'UnknownError'
        }
      );
    } finally {
      this.pendingProbes.delete(probeAuthorization.canonicalPath);
    }

    const now = new Date().toISOString();
    this.saveInspection(inspection, 'trusted', {
      trustedAt: now,
      trustedAppVersion: this.appVersion,
      versionOutput: version,
      probedAt: now
    });
    this.launchAuthorizations.clear();
    this.saveOverride(request.role, inspection.canonicalPath);
    this.audit('media_tool.trusted', request.role, {
      hashPrefix: inspection.sha256.slice(0, 12),
      signatureStatus: inspection.signature.status,
      appVersion: this.appVersion
    });
    return this.state(request.role);
  }

  clear(role: MediaToolRole): MediaToolState {
    const row = this.row(role);
    this.launchAuthorizations.clear();
    this.db.raw.prepare('DELETE FROM media_tool_trust WHERE role = ?').run(role);
    this.saveOverride(role, '');
    this.audit('media_tool.override_cleared', role, {
      previousStatus: row?.status ?? null,
      previousHashPrefix: row?.sha256?.slice(0, 12) ?? null
    });
    return this.state(role);
  }

  guardLaunch(executable: string): void {
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync.native(executable);
    } catch {
      const missingAuthorization = this.launchAuthorizations.get(executable)
        ?? this.pendingProbes.get(executable);
      if (missingAuthorization) {
        if (missingAuthorization.source === 'custom') this.markStatus(missingAuthorization.role, 'missing');
        this.audit('media_tool.execution_blocked', missingAuthorization.role, {
          source: missingAuthorization.source,
          expectedHashPrefix: missingAuthorization.sha256.slice(0, 12),
          reason: 'missing_before_launch'
        });
        this.reject(
          missingAuthorization.role,
          'execution.identity_check',
          'MEDIA_TOOL_MISSING',
          `Blocked ${missingAuthorization.role}: its executable disappeared before launch.`,
          'Restore the exact executable or inspect and trust its replacement before retrying.',
          { source: missingAuthorization.source, expectedHashPrefix: missingAuthorization.sha256.slice(0, 12) }
        );
      }
      return;
    }
    const authorization = this.pendingProbes.get(canonicalPath)
      ?? this.launchAuthorizations.get(canonicalPath);
    if (!authorization) return;

    if (authorization.source === 'custom') {
      const row = this.row(authorization.role);
      if (row?.status !== 'trusted'
        || row.canonical_path !== authorization.canonicalPath
        || row.sha256 !== authorization.sha256) {
        this.audit('media_tool.execution_blocked', authorization.role, {
          source: authorization.source,
          expectedHashPrefix: authorization.sha256.slice(0, 12),
          reason: 'trust_record_no_longer_matches'
        });
        this.reject(
          authorization.role,
          'execution.trust_check',
          'MEDIA_TOOL_TRUST_MISMATCH',
          `Blocked ${authorization.role}: its device-local trust record no longer matches.`,
          'Refresh tool status and explicitly trust the current executable before retrying.',
          { source: authorization.source, expectedHashPrefix: authorization.sha256.slice(0, 12) }
        );
      }
    }

    const observedHash = sha256File(canonicalPath);
    if (observedHash !== authorization.sha256) {
      if (authorization.source === 'custom') this.markStatus(authorization.role, 'changed');
      this.audit('media_tool.execution_blocked', authorization.role, {
        source: authorization.source,
        expectedHashPrefix: authorization.sha256.slice(0, 12),
        observedHashPrefix: observedHash.slice(0, 12),
        reason: 'hash_changed_before_launch'
      });
      this.reject(
        authorization.role,
        'execution.identity_check',
        'MEDIA_TOOL_HASH_CHANGED',
        `Blocked ${authorization.role}: its SHA-256 changed before execution.`,
        'Inspect the executable again and explicitly confirm its new identity before retrying.',
        {
          source: authorization.source,
          expectedHashPrefix: authorization.sha256.slice(0, 12),
          observedHashPrefix: observedHash.slice(0, 12)
        }
      );
    }
    this.audit('media_tool.execution_authorized', authorization.role, {
      source: authorization.source,
      hashPrefix: authorization.sha256.slice(0, 12)
    });
  }

  private inspectFile(
    role: MediaToolRole,
    requestedPath: string,
    signature: PlatformSignature
  ): MediaToolInspection {
    if (!requestedPath.trim() || !isAbsolute(requestedPath)) {
      throw new MediaToolInspectionError(
        'MEDIA_TOOL_PATH_INVALID',
        'Media tool paths must be absolute.',
        'Select the executable through the file picker or enter its absolute path.'
      );
    }
    let requestedStats;
    try {
      requestedStats = lstatSync(requestedPath);
    } catch {
      throw new MediaToolInspectionError(
        'MEDIA_TOOL_MISSING',
        'The selected media tool does not exist.',
        'Restore the file or select the current executable location.'
      );
    }
    if (requestedStats.isDirectory()) {
      throw new MediaToolInspectionError(
        'MEDIA_TOOL_NOT_FILE',
        'The selected media tool is a directory, not a file.',
        'Select the ffmpeg or ffprobe executable file inside the directory.'
      );
    }
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync.native(requestedPath);
    } catch {
      throw new MediaToolInspectionError(
        'MEDIA_TOOL_LINK_UNRESOLVED',
        'The selected media tool link could not be resolved.',
        'Repair the link or select the executable at its canonical location.'
      );
    }
    const stats = statSync(canonicalPath);
    if (!stats.isFile()) {
      throw new MediaToolInspectionError(
        'MEDIA_TOOL_NOT_FILE',
        'The selected media tool is not a regular file.',
        'Select a regular ffmpeg or ffprobe executable file.'
      );
    }
    if (stats.size <= 0) {
      throw new MediaToolInspectionError(
        'MEDIA_TOOL_EMPTY',
        'The selected media tool is empty.',
        'Replace the empty file with a valid executable and inspect it again.'
      );
    }
    const detected = detectedRole(canonicalPath, signature.originalFilename);
    return {
      role,
      requestedPath,
      canonicalPath,
      sha256: sha256File(canonicalPath),
      sizeBytes: stats.size,
      executableByCurrentUser: executableAccess(canonicalPath),
      detectedRole: detected,
      roleMatches: detected === role,
      signature: { status: signature.status, subject: signature.subject },
      inspectedAt: new Date().toISOString()
    };
  }

  private async inspectPlatformSignature(path: string): Promise<PlatformSignature> {
    if (process.platform !== 'win32') {
      return { status: 'unavailable', subject: null, originalFilename: null };
    }
    const systemRoot = process.env.SYSTEMROOT ?? process.env.WINDIR;
    if (!systemRoot) return { status: 'unavailable', subject: null, originalFilename: null };
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = [
      '$p=$args[0]',
      '$s=Get-AuthenticodeSignature -LiteralPath $p',
      '$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($p)',
      '[pscustomobject]@{Status=[string]$s.Status;Subject=$(if($s.SignerCertificate){$s.SignerCertificate.Subject}else{$null});OriginalFilename=$v.OriginalFilename}|ConvertTo-Json -Compress'
    ].join(';');
    try {
      const result = await runProcess(
        powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, path],
        { timeoutMs: 5_000 }
      );
      if (result.code !== 0) return { status: 'unknown', subject: null, originalFilename: null };
      const parsed = JSON.parse(result.stdout.trim()) as {
        Status?: unknown;
        Subject?: unknown;
        OriginalFilename?: unknown;
      };
      const rawStatus = String(parsed.Status ?? '').toLowerCase();
      const status: MediaToolSignature['status'] = rawStatus === 'valid'
        ? 'valid'
        : rawStatus === 'notsigned'
          ? 'unsigned'
          : ['hashmismatch', 'nottrusted'].includes(rawStatus)
            ? 'invalid'
            : 'unknown';
      return {
        status,
        subject: typeof parsed.Subject === 'string' ? parsed.Subject : null,
        originalFilename: typeof parsed.OriginalFilename === 'string' ? parsed.OriginalFilename : null
      };
    } catch {
      return { status: 'unavailable', subject: null, originalFilename: null };
    }
  }

  private customState(role: MediaToolRole, configuredPath: string): MediaToolState {
    let inspection: MediaToolInspection;
    try {
      const row = this.row(role);
      inspection = this.inspectFile(role, configuredPath, {
        status: row?.signature_status ?? 'unavailable',
        subject: row?.signature_subject ?? null,
        originalFilename: null
      });
    } catch (error) {
      this.saveUnavailable(role, configuredPath, 'missing');
      return this.emptyState(
        role,
        configuredPath,
        'missing',
        `The custom ${role} override is unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const row = this.row(role);
    if (!inspection.roleMatches) {
      this.saveInspection(inspection, 'role_mismatch');
      return this.inspectionState(inspection, 'role_mismatch', row, null,
        `The custom path does not identify as ${role}; it will not be executed.`);
    }
    if (!row || row.status !== 'trusted') {
      if (!row) this.saveInspection(inspection, 'confirmation_required');
      const status: MediaToolTrustStatus = row?.status === 'probe_failed'
        ? 'probe_failed'
        : row?.status === 'changed'
          ? 'changed'
          : 'confirmation_required';
      return this.inspectionState(inspection, status, row, null,
        status === 'probe_failed'
          ? 'The custom executable failed its bounded version probe and is revoked.'
          : status === 'changed'
            ? 'The custom executable identity changed after trust; inspect and confirm the new SHA-256.'
          : 'The custom executable requires local inspection and explicit confirmation.');
    }
    if (row.canonical_path !== inspection.canonicalPath || row.sha256 !== inspection.sha256) {
      this.markStatus(role, 'changed');
      return this.inspectionState(inspection, 'changed', row, null,
        'The custom executable identity changed after trust; it will not be executed.');
    }
    if (!inspection.executableByCurrentUser) {
      this.markStatus(role, 'probe_failed');
      return this.inspectionState(inspection, 'probe_failed', row, null,
        'The custom executable is no longer executable by the current user.');
    }
    return this.inspectionState(inspection, 'trusted', row, inspection.canonicalPath,
      'The device-local path and SHA-256 match the trusted record.');
  }

  private availableState(
    role: MediaToolRole,
    source: 'bundled' | 'path_fallback',
    status: MediaToolTrustStatus,
    configuredPath: string,
    executablePath: string,
    message: string
  ): MediaToolState {
    try {
      const canonicalPath = realpathSync.native(executablePath);
      const stats = statSync(canonicalPath);
      const digest = sha256File(canonicalPath);
      return {
        role,
        source,
        status,
        configuredPath,
        canonicalPath,
        sha256: digest,
        hashPrefix: digest.slice(0, 12),
        sizeBytes: stats.size,
        executableByCurrentUser: executableAccess(canonicalPath),
        signature: { status: 'unavailable', subject: null },
        trustedAt: source === 'bundled' ? null : this.row(role)?.trusted_at ?? null,
        trustedAppVersion: source === 'bundled' ? this.appVersion : this.row(role)?.trusted_app_version ?? null,
        version: this.row(role)?.version_output ?? null,
        executablePath: canonicalPath,
        message
      };
    } catch {
      return this.emptyState(role, configuredPath, 'unavailable', 'The selected fallback is no longer available.');
    }
  }

  private inspectionState(
    inspection: MediaToolInspection,
    status: MediaToolTrustStatus,
    row: TrustRow | undefined,
    executablePath: string | null,
    message: string
  ): MediaToolState {
    return {
      role: inspection.role,
      source: executablePath ? 'custom' : 'unavailable',
      status,
      configuredPath: inspection.requestedPath,
      canonicalPath: inspection.canonicalPath,
      sha256: inspection.sha256,
      hashPrefix: inspection.sha256.slice(0, 12),
      sizeBytes: inspection.sizeBytes,
      executableByCurrentUser: inspection.executableByCurrentUser,
      signature: inspection.signature,
      trustedAt: row?.trusted_at ?? null,
      trustedAppVersion: row?.trusted_app_version ?? null,
      version: row?.version_output ?? null,
      executablePath,
      message
    };
  }

  private emptyState(
    role: MediaToolRole,
    configuredPath: string,
    status: MediaToolTrustStatus,
    message: string
  ): MediaToolState {
    const row = this.row(role);
    return {
      role,
      source: 'unavailable',
      status,
      configuredPath,
      canonicalPath: row?.canonical_path ?? null,
      sha256: row?.sha256 ?? null,
      hashPrefix: row?.sha256?.slice(0, 12) ?? null,
      sizeBytes: row?.size_bytes ?? null,
      executableByCurrentUser: null,
      signature: {
        status: row?.signature_status ?? 'unavailable',
        subject: row?.signature_subject ?? null
      },
      trustedAt: row?.trusted_at ?? null,
      trustedAppVersion: row?.trusted_app_version ?? null,
      version: row?.version_output ?? null,
      executablePath: null,
      message
    };
  }

  private saveInspection(
    inspection: MediaToolInspection,
    status: TrustRow['status'],
    trusted: {
      trustedAt?: string | null;
      trustedAppVersion?: string | null;
      versionOutput?: string | null;
      probedAt?: string | null;
    } = {}
  ): void {
    const previous = this.row(inspection.role);
    this.db.raw.prepare(`
      INSERT INTO media_tool_trust(
        role, configured_path, canonical_path, sha256, size_bytes,
        signature_status, signature_subject, status, trusted_at,
        trusted_app_version, version_output, probed_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET
        configured_path = excluded.configured_path,
        canonical_path = excluded.canonical_path,
        sha256 = excluded.sha256,
        size_bytes = excluded.size_bytes,
        signature_status = excluded.signature_status,
        signature_subject = excluded.signature_subject,
        status = excluded.status,
        trusted_at = excluded.trusted_at,
        trusted_app_version = excluded.trusted_app_version,
        version_output = excluded.version_output,
        probed_at = excluded.probed_at,
        updated_at = excluded.updated_at
    `).run(
      inspection.role,
      inspection.requestedPath,
      inspection.canonicalPath,
      inspection.sha256,
      inspection.sizeBytes,
      inspection.signature.status,
      inspection.signature.subject,
      status,
      trusted.trustedAt ?? (status === 'trusted' ? previous?.trusted_at ?? null : null),
      trusted.trustedAppVersion ?? (status === 'trusted' ? previous?.trusted_app_version ?? null : null),
      trusted.versionOutput ?? (status === 'trusted' ? previous?.version_output ?? null : null),
      trusted.probedAt ?? (status === 'trusted' ? previous?.probed_at ?? null : null),
      new Date().toISOString()
    );
  }

  private saveUnavailable(role: MediaToolRole, configuredPath: string, status: 'missing'): void {
    const previous = this.row(role);
    this.db.raw.prepare(`
      INSERT INTO media_tool_trust(
        role, configured_path, canonical_path, sha256, size_bytes,
        signature_status, signature_subject, status, updated_at
      ) VALUES(?, ?, NULL, NULL, NULL, 'unavailable', NULL, ?, ?)
      ON CONFLICT(role) DO UPDATE SET
        configured_path = excluded.configured_path,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(role, configuredPath, status, new Date().toISOString());
    if (previous?.status !== status) this.launchAuthorizations.clear();
  }

  private markStatus(role: MediaToolRole, status: TrustRow['status']): void {
    this.db.raw.prepare(`
      UPDATE media_tool_trust SET status = ?, updated_at = ? WHERE role = ?
    `).run(status, new Date().toISOString(), role);
    this.launchAuthorizations.clear();
  }

  private row(role: MediaToolRole): TrustRow | undefined {
    return this.db.raw.prepare('SELECT * FROM media_tool_trust WHERE role = ?').get(role) as unknown as TrustRow | undefined;
  }

  private configuredPath(role: MediaToolRole): string {
    return role === 'ffmpeg' ? this.settings().ffmpegPath : this.settings().ffprobePath;
  }

  private sameCanonicalPath(left: string, right: string): boolean {
    try {
      return realpathSync.native(left) === realpathSync.native(right);
    } catch {
      return false;
    }
  }

  private reject(
    role: MediaToolRole,
    operation: string,
    code: MediaToolSecurityCode,
    message: string,
    recovery: string,
    context: Record<string, unknown> = {}
  ): never {
    return rejectPrivilegedOperation(this.db, {
      flow: 'media_tool',
      operation,
      code,
      recovery,
      entityType: 'media_tool',
      entityId: role,
      context
    }, message);
  }

  private audit(action: string, role: MediaToolRole, metadata: Record<string, unknown>): void {
    this.db.raw.prepare(`
      INSERT INTO audit_log(action, actor, entity_type, entity_id, metadata_json, created_at)
      VALUES(?, 'system', 'media_tool', ?, ?, ?)
    `).run(action, role, JSON.stringify(metadata), new Date().toISOString());
  }
}
