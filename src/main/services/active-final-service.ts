import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { AppDatabase } from '../database/database';
import { pathIsInside } from '../security-policy';
import { formatSecurityError, recordSecurityRejection } from '../security-events';
import { approvalFingerprint } from '@shared/approval';

export type ActiveFinalErrorCode =
  | 'PROJECT_MISSING'
  | 'ACTIVE_FINAL_MISSING'
  | 'RENDER_MISSING'
  | 'CROSS_PROJECT_RENDER'
  | 'NOT_FINAL_RENDER'
  | 'FINAL_RENDER_FAILED'
  | 'OUTPUT_PATH_MISSING'
  | 'OUTPUT_FILE_MISSING'
  | 'OUTPUT_NOT_MANAGED'
  | 'OUTPUT_NOT_REGULAR'
  | 'FINAL_HASH_MISSING'
  | 'FINAL_HASH_MISMATCH';

function activeFinalRecovery(code: ActiveFinalErrorCode): string {
  const recoveries: Record<ActiveFinalErrorCode, string> = {
    PROJECT_MISSING: 'Refresh the project list and select an existing project.',
    ACTIVE_FINAL_MISSING: 'Complete a final render and explicitly select it as the active final.',
    RENDER_MISSING: 'Create a new final render and select the completed replacement.',
    CROSS_PROJECT_RENDER: 'Select a final render that belongs to this project.',
    NOT_FINAL_RENDER: 'Complete and select a render created with the final-render workflow.',
    FINAL_RENDER_FAILED: 'Resolve the render failure and complete a new final render.',
    OUTPUT_PATH_MISSING: 'Create a new final render in managed output storage.',
    OUTPUT_FILE_MISSING: 'Restore the exact final file or create and approve a new final render.',
    OUTPUT_NOT_MANAGED: 'Create the final render inside the configured managed MP4 output folder.',
    OUTPUT_NOT_REGULAR: 'Replace the output with a regular MP4 file produced by the final renderer.',
    FINAL_HASH_MISSING: 'Create a new final render with a persisted SHA-256 receipt.',
    FINAL_HASH_MISMATCH: 'Treat the file as changed and create and approve a new final render.'
  };
  return recoveries[code];
}

export class ActiveFinalError extends Error {
  readonly recovery: string;

  constructor(
    readonly code: ActiveFinalErrorCode,
    readonly detail: string,
    recovery = activeFinalRecovery(code)
  ) {
    super(formatSecurityError(code, detail, recovery));
    this.name = 'ActiveFinalError';
    this.recovery = recovery;
  }
}

export interface ActiveFinalArtifact {
  id: string;
  projectId: string;
  kind: 'final';
  state: 'SUCCEEDED';
  profile: string;
  manifestPath: string | null;
  outputPath: string;
  sha256: string;
  artifactVersion: number;
  createdAt: string;
  completedAt: string | null;
}

interface ActiveFinalRow {
  id: string;
  project_id: string;
  kind: string;
  profile: string;
  state: string;
  manifest_path: string | null;
  output_path: string | null;
  sha256: string | null;
  artifact_version: number;
  created_at: string;
  completed_at: string | null;
}

interface CachedFileHash {
  path: string;
  expected: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  inode: number;
  actual: string;
}

export function sha256File(path: string): string {
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

export class ActiveFinalService {
  private readonly hashes = new Map<string, CachedFileHash>();

  constructor(
    private readonly db: AppDatabase,
    private readonly outputFolder: () => string
  ) {}

  requireActiveFinal(projectId: string): ActiveFinalArtifact {
    const project = this.db.raw.prepare(`
      SELECT final_render_id FROM projects WHERE id = ?
    `).get(projectId) as { final_render_id: string | null } | undefined;
    if (!project) throw new ActiveFinalError('PROJECT_MISSING', 'Project not found.');
    if (!project.final_render_id) {
      throw new ActiveFinalError('ACTIVE_FINAL_MISSING', 'The project does not have an active final render.');
    }

    const row = this.db.raw.prepare(`SELECT * FROM renders WHERE id = ?`).get(project.final_render_id) as
      | ActiveFinalRow
      | undefined;
    if (!row) {
      throw new ActiveFinalError('RENDER_MISSING', 'The active final render record does not exist.');
    }
    if (row.project_id !== projectId) {
      throw new ActiveFinalError('CROSS_PROJECT_RENDER', 'The active final render belongs to a different project.');
    }
    if (row.kind !== 'final') {
      throw new ActiveFinalError('NOT_FINAL_RENDER', 'The active render is not a final render.');
    }
    if (row.state !== 'SUCCEEDED') {
      throw new ActiveFinalError('FINAL_RENDER_FAILED', 'The active final render has not succeeded.');
    }
    if (!row.output_path) {
      throw new ActiveFinalError('OUTPUT_PATH_MISSING', 'The active final render has no managed output path.');
    }
    if (!row.sha256 || !/^[a-f0-9]{64}$/i.test(row.sha256)) {
      throw new ActiveFinalError('FINAL_HASH_MISSING', 'The active final render has no valid persisted SHA-256.');
    }

    let canonicalOutput: string;
    try {
      canonicalOutput = realpathSync(row.output_path);
    } catch {
      throw new ActiveFinalError('OUTPUT_FILE_MISSING', 'The active final render output file is missing.');
    }
    const root = this.outputFolder().trim();
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(root);
    } catch {
      throw new ActiveFinalError('OUTPUT_NOT_MANAGED', 'The managed output folder is unavailable.');
    }
    if (!pathIsInside(canonicalOutput, [canonicalRoot])
      || canonicalOutput === canonicalRoot
      || extname(canonicalOutput).toLowerCase() !== '.mp4') {
      throw new ActiveFinalError('OUTPUT_NOT_MANAGED', 'The active final render is outside managed MP4 storage.');
    }

    const stats = statSync(canonicalOutput);
    if (!stats.isFile()) {
      throw new ActiveFinalError('OUTPUT_NOT_REGULAR', 'The active final render output is not a regular file.');
    }
    const cached = this.hashes.get(row.id);
    const expected = row.sha256.toLowerCase();
    const actual = cached
      && cached.path === canonicalOutput
      && cached.expected === expected
      && cached.size === stats.size
      && cached.mtimeMs === stats.mtimeMs
      && cached.ctimeMs === stats.ctimeMs
      && cached.inode === stats.ino
      ? cached.actual
      : sha256File(canonicalOutput);
    this.hashes.set(row.id, {
      path: canonicalOutput,
      expected,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      inode: stats.ino,
      actual
    });
    if (actual !== expected) {
      throw new ActiveFinalError('FINAL_HASH_MISMATCH', 'The active final render does not match its persisted SHA-256.');
    }

    return {
      id: row.id,
      projectId: row.project_id,
      kind: 'final',
      state: 'SUCCEEDED',
      profile: row.profile,
      manifestPath: row.manifest_path,
      outputPath: canonicalOutput,
      sha256: expected,
      artifactVersion: Number(row.artifact_version ?? 1),
      createdAt: row.created_at,
      completedAt: row.completed_at
    };
  }
}

export interface PublicationSnapshot {
  snapshotVersion: 1;
  projectId: string;
  finalRenderId: string;
  finalSha256: string;
  finalOutputPath: string;
  finalManifestPath: string | null;
  selectedPackageId: string;
  title: string;
  description: string;
  chapters: string;
  tags: string[];
  thumbnailPath: string;
  thumbnailSha256: string;
  approvalHash: string;
  confirmedChannelId: string;
}

interface PackageRow {
  id: string;
  title: string;
  description: string;
  chapters: string;
  tags_json: string;
  thumbnail_path: string | null;
  risk_status: string;
}

export type PublicationBoundary =
  | 'job_start'
  | 'upload_create'
  | 'upload_resume'
  | 'upload_chunk'
  | 'metadata'
  | 'thumbnail'
  | 'caption'
  | 'playlist'
  | 'processing'
  | 'approval'
  | 'publish';

export class StalePublicationSnapshotError extends Error {
  readonly code = 'STALE_PUBLICATION_SNAPSHOT';
  readonly recovery = 'Keep the stale upload private, capture the current publication package, and review the new private upload.';

  constructor(readonly boundary: PublicationBoundary, readonly detail: string) {
    super(formatSecurityError('STALE_PUBLICATION_SNAPSHOT', detail,
      'Keep the stale upload private, capture the current publication package, and review the new private upload.'));
    this.name = 'StalePublicationSnapshotError';
  }
}

export type PublicationIdentityErrorCode =
  | 'PUBLICATION_CHANNEL_MISMATCH'
  | 'PUBLICATION_PACKAGE_SELECTION_INVALID'
  | 'PUBLICATION_PACKAGE_BLOCKED'
  | 'PUBLICATION_THUMBNAIL_REQUIRED'
  | 'PUBLICATION_THUMBNAIL_MISSING'
  | 'PUBLICATION_THUMBNAIL_NOT_FILE'
  | 'PUBLICATION_TAGS_INVALID'
  | 'PUBLICATION_CAPTURE_FAILED';

export class PublicationIdentityError extends Error {
  readonly recovery: string;

  constructor(
    readonly code: PublicationIdentityErrorCode,
    readonly detail: string,
    recovery: string
  ) {
    super(formatSecurityError(code, detail, recovery));
    this.name = 'PublicationIdentityError';
    this.recovery = recovery;
  }
}

function sameIdentity(left: PublicationSnapshot, right: PublicationSnapshot): boolean {
  return left.snapshotVersion === right.snapshotVersion
    && left.projectId === right.projectId
    && left.finalRenderId === right.finalRenderId
    && left.finalSha256 === right.finalSha256
    && left.selectedPackageId === right.selectedPackageId
    && left.approvalHash === right.approvalHash
    && left.confirmedChannelId === right.confirmedChannelId;
}

interface StalePublicationRow {
  id: string;
  video_id: string | null;
  upload_session_uri: string | null;
  final_render_id: string | null;
  final_sha256: string;
  selected_package_id: string | null;
  channel_id: string | null;
}

function staleRows(
  db: AppDatabase,
  projectId: string,
  rows: StalePublicationRow[],
  reason: string,
  boundary: string,
  now: string
): void {
  db.raw.transaction(() => {
    for (const row of rows) {
      db.raw.prepare(`
        UPDATE publication_records SET snapshot_status = 'stale', privacy_status = 'private',
          approval_hash = NULL, approved_at = NULL, scheduled_at = NULL, published_at = NULL,
          error = ?, updated_at = ?
        WHERE id = ?
      `).run(reason, now, row.id);
      recordSecurityRejection(db, {
        flow: 'publication',
        operation: 'snapshot.invalidation',
        code: 'STALE_PUBLICATION_SNAPSHOT',
        recovery: 'Keep the stale upload private, capture the current publication package, and review the new private upload.',
        entityType: 'publication',
        entityId: row.id,
        context: {
          projectId,
          boundary,
          hasRemoteVideo: Boolean(row.video_id),
          hasUploadSession: Boolean(row.upload_session_uri),
          finalRenderPresent: Boolean(row.final_render_id),
          selectedPackagePresent: Boolean(row.selected_package_id),
          channelBindingPresent: Boolean(row.channel_id)
        }
      });
      if (!row.video_id && !row.upload_session_uri) continue;
      const existing = db.raw.prepare(`
        SELECT id FROM exceptions
        WHERE project_id = ? AND code = 'STALE_PUBLICATION_SNAPSHOT' AND status = 'OPEN'
          AND json_extract(evidence_json, '$.publicationId') = ?
        LIMIT 1
      `).get(projectId, row.id);
      if (existing) continue;
      db.raw.prepare(`
        INSERT INTO exceptions(
          id, project_id, severity, stage, code, title, message, evidence_json,
          recommended_action, safe_alternatives_json, status, created_at
        ) VALUES(?, ?, 'BLOCKER', 'publishing', 'STALE_PUBLICATION_SNAPSHOT',
          'A private YouTube upload is stale', ?, ?,
          'Review the active final, upload its current package privately, then remove the stale private video in YouTube Studio.',
          ?, 'OPEN', ?)
      `).run(
        randomUUID(),
        projectId,
        reason,
        JSON.stringify({
          publicationId: row.id,
          videoId: row.video_id,
          hasUploadSession: Boolean(row.upload_session_uri),
          finalRenderId: row.final_render_id,
          finalSha256: row.final_sha256,
          selectedPackageId: row.selected_package_id,
          channelId: row.channel_id,
          boundary
        }),
        JSON.stringify(['Keep the stale video private', 'Delete the stale video in YouTube Studio']),
        now
      );
    }
  })();
}

export function invalidatePublicationSnapshots(
  db: AppDatabase,
  projectId: string,
  reason: string,
  boundary = 'project_mutation',
  now = new Date().toISOString()
): number {
  return db.raw.transaction(() => {
    const rows = db.raw.prepare(`
      SELECT id, video_id, upload_session_uri, final_render_id, final_sha256,
        selected_package_id, channel_id
      FROM publication_records
      WHERE project_id = ? AND snapshot_status = 'current'
    `).all(projectId) as unknown as StalePublicationRow[];
    staleRows(db, projectId, rows, reason, boundary, now);
    db.raw.prepare(`
      UPDATE publication_records SET approval_hash = NULL, approved_at = NULL,
        scheduled_at = NULL, published_at = NULL, updated_at = ?
      WHERE project_id = ? AND snapshot_status <> 'current'
        AND (approval_hash IS NOT NULL OR approved_at IS NOT NULL
          OR scheduled_at IS NOT NULL OR published_at IS NOT NULL)
    `).run(now, projectId);
    return rows.length;
  })();
}

export class PublicationIdentityService {
  constructor(
    private readonly db: AppDatabase,
    readonly activeFinal: ActiveFinalService
  ) {}

  capture(projectId: string, confirmedChannelId: string): PublicationSnapshot {
    try {
      return this.captureCandidate(projectId, confirmedChannelId);
    } catch (error) {
      const normalized = error instanceof ActiveFinalError || error instanceof PublicationIdentityError
        ? error
        : new PublicationIdentityError(
          'PUBLICATION_CAPTURE_FAILED',
          'The publication identity could not be captured safely.',
          'Refresh project state and retry after checking managed output and database health.'
        );
      recordSecurityRejection(this.db, {
        flow: 'publication',
        operation: 'snapshot.capture',
        code: normalized.code,
        recovery: normalized.recovery,
        entityType: 'publication',
        entityId: projectId,
        context: {
          confirmedChannelProvided: Boolean(confirmedChannelId.trim()),
          errorType: error instanceof Error ? error.name : 'UnknownError'
        }
      });
      throw normalized;
    }
  }

  private captureCandidate(projectId: string, confirmedChannelId: string): PublicationSnapshot {
    const channelId = confirmedChannelId.trim();
    const binding = this.db.raw.prepare(`
      SELECT channel_id FROM youtube_connection_binding WHERE singleton_id = 1
    `).get() as { channel_id: string } | undefined;
    if (!channelId || binding?.channel_id !== channelId) {
      throw new PublicationIdentityError(
        'PUBLICATION_CHANNEL_MISMATCH',
        'The confirmed YouTube channel changed or is no longer available.',
        'Reconnect YouTube and explicitly confirm the exact destination channel.'
      );
    }
    const final = this.activeFinal.requireActiveFinal(projectId);
    const packages = this.db.raw.prepare(`
      SELECT id, title, description, chapters, tags_json, thumbnail_path, risk_status
      FROM packaging_candidates WHERE project_id = ? AND selected = 1
      ORDER BY ordinal
    `).all(projectId) as unknown as PackageRow[];
    if (packages.length !== 1) {
      throw new PublicationIdentityError(
        'PUBLICATION_PACKAGE_SELECTION_INVALID',
        'Exactly one selected publishing package is required.',
        'Select exactly one publishing package and run publishing QC again.'
      );
    }
    const selected = packages[0]!;
    if (selected.risk_status === 'blocked') {
      throw new PublicationIdentityError(
        'PUBLICATION_PACKAGE_BLOCKED',
        'The selected publishing package is blocked by publishing QC.',
        'Resolve the publishing QC blockers or select a package that passes QC.'
      );
    }
    if (!selected.thumbnail_path) {
      throw new PublicationIdentityError(
        'PUBLICATION_THUMBNAIL_REQUIRED',
        'The selected publishing package requires a generated thumbnail.',
        'Generate and select the package thumbnail before creating an upload snapshot.'
      );
    }
    let thumbnailPath: string;
    try {
      thumbnailPath = realpathSync(selected.thumbnail_path);
    } catch {
      throw new PublicationIdentityError(
        'PUBLICATION_THUMBNAIL_MISSING',
        'The selected publishing package thumbnail is missing.',
        'Regenerate the thumbnail and select the repaired publishing package.'
      );
    }
    if (!statSync(thumbnailPath).isFile()) {
      throw new PublicationIdentityError(
        'PUBLICATION_THUMBNAIL_NOT_FILE',
        'The selected publishing package thumbnail is not a regular file.',
        'Replace it with a generated thumbnail image file and run publishing QC again.'
      );
    }
    const thumbnailSha256 = sha256File(thumbnailPath);
    const tags = JSON.parse(selected.tags_json) as unknown;
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) {
      throw new PublicationIdentityError(
        'PUBLICATION_TAGS_INVALID',
        'The selected publishing package tags are invalid.',
        'Repair the package tags and run publishing QC before retrying.'
      );
    }
    const approvalHash = approvalFingerprint({
      finalSha256: final.sha256,
      packageId: selected.id,
      title: selected.title,
      description: selected.description,
      chapters: selected.chapters,
      tags: tags as string[],
      thumbnailSha256
    });
    return {
      snapshotVersion: 1,
      projectId,
      finalRenderId: final.id,
      finalSha256: final.sha256,
      finalOutputPath: final.outputPath,
      finalManifestPath: final.manifestPath,
      selectedPackageId: selected.id,
      title: selected.title,
      description: selected.description,
      chapters: selected.chapters,
      tags: tags as string[],
      thumbnailPath,
      thumbnailSha256,
      approvalHash,
      confirmedChannelId: channelId
    };
  }

  markSuperseded(snapshot: PublicationSnapshot): number {
    const rows = this.db.raw.prepare(`
      SELECT id, video_id, upload_session_uri, final_render_id, final_sha256,
        selected_package_id, channel_id
      FROM publication_records
      WHERE project_id = ? AND snapshot_status = 'current'
        AND NOT (
          final_render_id IS ? AND final_sha256 IS ? AND selected_package_id IS ?
          AND approval_hash IS ? AND channel_id IS ? AND snapshot_version IS ?
        )
    `).all(
      snapshot.projectId,
      snapshot.finalRenderId,
      snapshot.finalSha256,
      snapshot.selectedPackageId,
      snapshot.approvalHash,
      snapshot.confirmedChannelId,
      snapshot.snapshotVersion
    ) as unknown as StalePublicationRow[];
    const now = new Date().toISOString();
    staleRows(
      this.db,
      snapshot.projectId,
      rows,
      'The active final render, publishing package, or confirmed channel changed. The prior remote upload must remain private.',
      'job_start',
      now
    );
    return rows.length;
  }

  markStale(
    projectId: string,
    publicationId: string,
    boundary: PublicationBoundary,
    reason: string
  ): void {
    const row = this.db.raw.prepare(`
      SELECT id, video_id, upload_session_uri, final_render_id, final_sha256,
        selected_package_id, channel_id
      FROM publication_records WHERE id = ? AND project_id = ?
    `).get(publicationId, projectId) as StalePublicationRow | undefined;
    if (!row) return;
    staleRows(this.db, projectId, [row], reason, boundary, new Date().toISOString());
  }

  resolveStaleException(projectId: string, publicationId: string): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      UPDATE exceptions SET status = 'RESOLVED', resolved_at = ?, resolution_json = ?
      WHERE project_id = ? AND code = 'STALE_PUBLICATION_SNAPSHOT' AND status = 'OPEN'
        AND json_extract(evidence_json, '$.publicationId') = ?
    `).run(
      now,
      JSON.stringify({ outcome: 'publication_snapshot_resynchronized', publicationId }),
      projectId,
      publicationId
    );
  }

  assertCurrent(
    snapshot: PublicationSnapshot,
    publicationId: string,
    boundary: PublicationBoundary
  ): void {
    let reason: string | null = null;
    try {
      const current = this.captureCandidate(snapshot.projectId, snapshot.confirmedChannelId);
      if (!sameIdentity(snapshot, current)) {
        reason = 'The active final render or publishing package changed after the private upload snapshot was created.';
      }
    } catch (error) {
      reason = error instanceof ActiveFinalError || error instanceof PublicationIdentityError
        ? error.detail
        : 'The publication identity could not be revalidated safely.';
    }
    const row = this.db.raw.prepare(`
      SELECT id, video_id, upload_session_uri, final_render_id, final_sha256,
        selected_package_id, channel_id, approval_hash, snapshot_version, snapshot_status
      FROM publication_records WHERE id = ? AND project_id = ?
    `).get(publicationId, snapshot.projectId) as (StalePublicationRow & {
      approval_hash: string | null;
      snapshot_version: number;
      snapshot_status: string;
    }) | undefined;
    if (!row) reason ??= 'The publication snapshot record is missing.';
    if (row && (
      row.snapshot_status !== 'current'
      || row.final_render_id !== snapshot.finalRenderId
      || row.final_sha256 !== snapshot.finalSha256
      || row.selected_package_id !== snapshot.selectedPackageId
      || row.approval_hash !== snapshot.approvalHash
      || row.channel_id !== snapshot.confirmedChannelId
      || row.snapshot_version !== snapshot.snapshotVersion
    )) {
      reason ??= 'The persisted publication snapshot no longer matches the upload operation.';
    }
    if (!reason) return;
    const message = `${reason} The stale YouTube upload remains private and cannot be approved.`;
    if (row) {
      staleRows(this.db, snapshot.projectId, [row], message, boundary, new Date().toISOString());
    } else {
      recordSecurityRejection(this.db, {
        flow: 'publication',
        operation: 'snapshot.current_check',
        code: 'STALE_PUBLICATION_SNAPSHOT',
        recovery: 'Keep the stale upload private, capture the current publication package, and review the new private upload.',
        entityType: 'publication',
        entityId: publicationId,
        context: {
          projectId: snapshot.projectId,
          boundary,
          publicationRecordPresent: false
        }
      });
    }
    throw new StalePublicationSnapshotError(boundary, message);
  }
}
