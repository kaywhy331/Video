import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { AppDatabase } from '../database/database';
import type {
  AppSettings,
  DerivativeRebuildReport,
  NarrationWord,
  ProjectExportOptions,
  ProjectExportReport
} from '@shared/types';
import type { SceneEditingPlan } from '@shared/editing';
import { captionCuesFromWords } from '@shared/narration';
import { resolveFfmpeg } from '../tool-paths';
import { requireSuccess } from './process-utils';
import { EditingService } from './editing-service';

interface ExportArtifact {
  path: string;
  category: string;
  sizeBytes: number;
  sha256: string;
  sourcePath: string | null;
}

interface PortableRenderManifest {
  output?: { width?: number; height?: number };
  captions?: { srtPath?: string; vttPath?: string };
  scenes?: Array<{
    durationMs?: number;
    editingLayerPath?: string;
    editingPlan?: SceneEditingPlan;
    wordTimings?: NarrationWord[];
  }>;
}

function jsonArray(value: unknown): string[] {
  try {
    const decoded = JSON.parse(String(value ?? '[]'));
    return Array.isArray(decoded) ? decoded.map(String) : [];
  } catch {
    return [];
  }
}

function safeTimestamp(value = new Date()): string {
  return value.toISOString().replace(/[:.]/g, '-');
}

function safeName(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 100) || 'artifact';
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256Buffer(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function srtTime(ms: number): string {
  const total = Math.max(0, ms);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = Math.floor(total % 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function vttTime(ms: number): string {
  return srtTime(ms).replace(',', '.');
}

function exportFromRow(row: Record<string, unknown>): ProjectExportReport {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    exportPath: String(row.export_path),
    manifestPath: row.manifest_path ? String(row.manifest_path) : null,
    manifestSha256: row.manifest_sha256 ? String(row.manifest_sha256) : null,
    artifactCount: Number(row.artifact_count),
    totalBytes: Number(row.total_bytes),
    missingFiles: jsonArray(row.missing_files_json),
    status: row.status as ProjectExportReport['status'],
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null
  };
}

function rebuildFromRow(row: Record<string, unknown>): DerivativeRebuildReport {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    checkedOriginals: Number(row.checked_originals),
    rebuiltProxies: Number(row.rebuilt_proxies),
    rebuiltContactSheets: Number(row.rebuilt_contact_sheets),
    rebuiltVoiceTimings: Number(row.rebuilt_voice_timings),
    rebuiltEditingLayers: Number(row.rebuilt_editing_layers),
    rebuiltCaptionFiles: Number(row.rebuilt_caption_files),
    staleRenderFragments: Number(row.stale_render_fragments),
    missingOriginals: jsonArray(row.missing_originals_json),
    missingVoice: jsonArray(row.missing_voice_json),
    failures: jsonArray(row.failures_json),
    status: row.status as DerivativeRebuildReport['status'],
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null
  };
}

export class ProjectArtifactService {
  private readonly editing: EditingService;

  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings
  ) {
    this.editing = new EditingService(db, settings);
  }

  async exportProject(
    projectId: string,
    destinationRoot: string,
    options: ProjectExportOptions = { includeOriginals: false, includeFinalOutput: true }
  ): Promise<ProjectExportReport> {
    const project = this.db.raw.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
    if (!project) throw new Error('Project not found for export.');
    const runId = randomUUID();
    const createdAt = new Date().toISOString();
    const exportPath = join(destinationRoot, `${safeName(String(project.slug))}-export-${safeTimestamp()}-${runId.slice(0, 8)}`);
    mkdirSync(exportPath, { recursive: true });
    this.db.raw.prepare(`
      INSERT INTO project_export_runs(
        id, project_id, export_path, options_json, status, created_at
      ) VALUES(?, ?, ?, ?, 'running', ?)
    `).run(runId, projectId, exportPath, JSON.stringify(options), createdAt);

    const artifacts: ExportArtifact[] = [];
    const missingFiles: string[] = [];
    const addWrittenFile = async (relativePath: string, category: string, sourcePath: string | null = null): Promise<void> => {
      const path = join(exportPath, relativePath);
      artifacts.push({
        path: relativePath.replaceAll('\\', '/'),
        category,
        sizeBytes: statSync(path).size,
        sha256: await sha256File(path),
        sourcePath
      });
    };
    const writeDocument = async (relativePath: string, category: string, value: unknown): Promise<void> => {
      const path = join(exportPath, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, stableJson(value), 'utf8');
      await addWrittenFile(relativePath, category);
    };
    const copyArtifact = async (sourcePath: string | null | undefined, relativePath: string, category: string): Promise<void> => {
      if (!sourcePath || !existsSync(sourcePath)) {
        missingFiles.push(`${category}:${sourcePath ?? 'unset'}`);
        return;
      }
      const destination = join(exportPath, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(sourcePath, destination);
      const [sourceHash, destinationHash] = await Promise.all([sha256File(sourcePath), sha256File(destination)]);
      if (sourceHash !== destinationHash) throw new Error(`Export checksum mismatch for ${sourcePath}.`);
      await addWrittenFile(relativePath, category, sourcePath);
    };

    try {
      const rows = this.exportRows(projectId);
      await writeDocument('metadata/project.json', 'project_metadata', {
        schemaVersion: 'project-export-v1',
        exportedAt: createdAt,
        project: rows.project,
        projectGuidance: rows.projectGuidance,
        schemaMigrations: rows.schemaMigrations,
        options
      });
      await writeDocument('metadata/scripts-sources-claims.json', 'script_and_research_metadata', {
        scriptVersions: rows.scriptVersions,
        researchSources: rows.researchSources,
        factClaims: rows.factClaims,
        factClaimSources: rows.factClaimSources,
        projectSceneClaims: rows.projectSceneClaims
      });
      await writeDocument('metadata/scene-contracts.json', 'scene_contract_metadata', {
        scenes: rows.scenes,
        shotCandidates: rows.shotCandidates,
        footageVerifications: rows.footageVerifications,
        places: rows.places
      });
      await writeDocument('metadata/assets-files-licenses.json', 'asset_and_rights_metadata', {
        acquisitions: rows.acquisitions,
        licenses: rows.licenses,
        assets: rows.assets,
        assetFiles: rows.assetFiles,
        mediaSegments: rows.mediaSegments
      });
      await writeDocument('metadata/narration.json', 'narration_metadata', {
        voiceAssets: rows.voiceAssets,
        narrationSections: rows.narrationSections,
        narrationWords: rows.narrationWords
      });
      await writeDocument('metadata/renders-qc-packaging.json', 'render_metadata', {
        renderManifests: rows.renderManifests,
        renders: rows.renders,
        renderFragments: rows.renderFragments,
        qcResults: rows.qcResults,
        packagingCandidates: rows.packagingCandidates,
        repairAttempts: rows.repairAttempts
      });
      await writeDocument('metadata/publication-audit.json', 'publication_metadata', {
        publicationRecords: rows.publicationRecords.map(row => ({
          ...row,
          upload_session_uri: null,
          upload_session_present: Boolean(row.upload_session_uri)
        })),
        auditLog: rows.auditLog
      });

      for (const row of rows.licenses) {
        const certificate = row.certificate_path ? String(row.certificate_path) : null;
        if (certificate) await copyArtifact(certificate, `files/licenses/${safeName(String(row.id))}-${safeName(basename(certificate))}`, 'license_certificate');
      }
      for (const row of rows.voiceAssets) {
        const audio = row.audio_path ? String(row.audio_path) : null;
        const timing = row.timing_path ? String(row.timing_path) : null;
        await copyArtifact(audio, `files/voice/${safeName(String(row.id))}${audio ? extname(audio) || '.wav' : '.wav'}`, 'voice_audio');
        await copyArtifact(timing, `files/voice/${safeName(String(row.id))}.timing.json`, 'voice_timing');
      }
      for (const row of rows.renderManifests) {
        const path = row.path ? String(row.path) : null;
        await copyArtifact(path, `files/render-manifests/${safeName(String(row.id))}.json`, 'render_manifest');
        const manifest = this.decodeManifest(row.manifest_json);
        if (manifest.captions?.srtPath) await copyArtifact(manifest.captions.srtPath, `files/captions/${safeName(String(row.id))}.srt`, 'caption_srt');
        if (manifest.captions?.vttPath) await copyArtifact(manifest.captions.vttPath, `files/captions/${safeName(String(row.id))}.vtt`, 'caption_vtt');
      }
      for (const row of rows.packagingCandidates) {
        const thumbnail = row.thumbnail_path ? String(row.thumbnail_path) : null;
        if (thumbnail) await copyArtifact(thumbnail, `files/thumbnails/concept-${Number(row.ordinal)}${extname(thumbnail).toLowerCase() || '.jpg'}`, 'thumbnail');
      }
      if (options.includeFinalOutput) {
        const final = rows.renders.find(row => row.kind === 'final' && row.state === 'SUCCEEDED' && row.output_path);
        if (final) await copyArtifact(String(final.output_path), `files/final/${safeName(String(project.slug))}-final.mp4`, 'final_output');
        else missingFiles.push('final_output:no successful final render');
      }
      if (options.includeOriginals) {
        for (const row of rows.assetFiles) {
          const original = row.original_path ? String(row.original_path) : null;
          const suffix = original ? extname(original).toLowerCase() : '';
          await copyArtifact(original, `files/originals/${safeName(String(row.sha256))}${suffix}`, 'source_original');
        }
      }

      artifacts.sort((left, right) => left.path.localeCompare(right.path));
      const indexPath = join(exportPath, 'artifact-index.json');
      const indexDocument = stableJson({
        schemaVersion: 'artifact-index-v1',
        projectId,
        exportRunId: runId,
        createdAt,
        options,
        artifactCount: artifacts.length,
        totalBytes: artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
        missingFiles: [...new Set(missingFiles)].sort(),
        artifacts
      });
      writeFileSync(indexPath, indexDocument, 'utf8');
      const indexHash = sha256Buffer(indexDocument);
      const completedAt = new Date().toISOString();
      const status: ProjectExportReport['status'] = missingFiles.length ? 'partial' : 'complete';
      this.db.raw.prepare(`
        UPDATE project_export_runs SET manifest_path = ?, manifest_sha256 = ?,
          artifact_count = ?, total_bytes = ?, missing_files_json = ?, status = ?, completed_at = ?
        WHERE id = ?
      `).run(
        indexPath,
        indexHash,
        artifacts.length,
        artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
        JSON.stringify([...new Set(missingFiles)].sort()),
        status,
        completedAt,
        runId
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.raw.prepare(`
        UPDATE project_export_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?
      `).run(message, new Date().toISOString(), runId);
      throw error;
    }
    return exportFromRow(this.db.raw.prepare('SELECT * FROM project_export_runs WHERE id = ?').get(runId) as Record<string, unknown>);
  }

  async rebuildProject(projectId: string): Promise<DerivativeRebuildReport> {
    const project = this.db.raw.prepare('SELECT id, slug FROM projects WHERE id = ?').get(projectId) as { id: string; slug: string } | undefined;
    if (!project) throw new Error('Project not found for derivative rebuild.');
    const runId = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO derivative_rebuild_runs(id, project_id, status, created_at)
      VALUES(?, ?, 'running', ?)
    `).run(runId, projectId, createdAt);
    const counters = {
      checkedOriginals: 0,
      rebuiltProxies: 0,
      rebuiltContactSheets: 0,
      rebuiltVoiceTimings: 0,
      rebuiltEditingLayers: 0,
      rebuiltCaptionFiles: 0,
      staleRenderFragments: 0
    };
    const missingOriginals: string[] = [];
    const missingVoice: string[] = [];
    const failures: string[] = [];

    try {
      const ffmpeg = resolveFfmpeg(this.settings().ffmpegPath);
      const files = this.projectAssetFiles(projectId);
      for (const row of files) {
        counters.checkedOriginals += 1;
        const originalPath = String(row.original_path);
        const expectedHash = String(row.sha256);
        if (!existsSync(originalPath)) {
          missingOriginals.push(`${expectedHash}:${originalPath}`);
          continue;
        }
        const actualHash = await sha256File(originalPath);
        if (actualHash !== expectedHash) {
          missingOriginals.push(`${expectedHash}:${originalPath}:hash_mismatch:${actualHash}`);
          continue;
        }
        const proxyPath = row.proxy_path
          ? String(row.proxy_path)
          : join(this.settings().mediaLibraryFolder, 'proxies', expectedHash.slice(0, 2), `${expectedHash}.mp4`);
        const contactSheetPath = row.contact_sheet_path
          ? String(row.contact_sheet_path)
          : join(this.settings().mediaLibraryFolder, 'keyframes', expectedHash.slice(0, 2), `${expectedHash}-contact.jpg`);
        if (!existsSync(proxyPath)) {
          if (!ffmpeg) failures.push(`proxy:${row.id}:FFmpeg unavailable`);
          else try {
            await this.createProxy(ffmpeg, originalPath, proxyPath, Boolean(row.audio_present));
            counters.rebuiltProxies += 1;
          } catch (error) {
            failures.push(`proxy:${row.id}:${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (!existsSync(contactSheetPath)) {
          if (!ffmpeg) failures.push(`contact_sheet:${row.id}:FFmpeg unavailable`);
          else try {
            await this.createContactSheet(ffmpeg, originalPath, contactSheetPath);
            counters.rebuiltContactSheets += 1;
          } catch (error) {
            failures.push(`contact_sheet:${row.id}:${error instanceof Error ? error.message : String(error)}`);
          }
        }
        this.db.raw.prepare(`
          UPDATE asset_files SET proxy_path = ?, contact_sheet_path = ? WHERE id = ?
        `).run(existsSync(proxyPath) ? proxyPath : null, existsSync(contactSheetPath) ? contactSheetPath : null, row.id);
      }

      const voices = this.db.raw.prepare(`
        SELECT DISTINCT v.* FROM voice_assets v
        JOIN narration_sections n ON n.voice_asset_id = v.id
        WHERE n.project_id = ? AND n.status = 'ready' AND v.status = 'ready'
        ORDER BY v.id
      `).all(projectId) as Array<Record<string, unknown>>;
      for (const voice of voices) {
        const audioPath = voice.audio_path ? String(voice.audio_path) : '';
        if (!audioPath || !existsSync(audioPath)) {
          missingVoice.push(`${String(voice.id)}:${audioPath || 'unset'}`);
          continue;
        }
        const timingPath = voice.timing_path
          ? String(voice.timing_path)
          : audioPath.replace(/\.[^.]+$/, '.timing.json');
        if (existsSync(timingPath)) continue;
        const words = this.db.raw.prepare(`
          SELECT w.word, w.start_ms, w.end_ms, w.confidence, w.timing_method
          FROM narration_words w
          JOIN narration_sections n ON n.id = w.section_id
          WHERE n.voice_asset_id = ? ORDER BY n.ordinal, w.ordinal
        `).all(voice.id) as Array<Record<string, unknown>>;
        if (!words.length) {
          failures.push(`voice_timing:${String(voice.id)}:no persisted narration words`);
          continue;
        }
        mkdirSync(dirname(timingPath), { recursive: true });
        writeFileSync(timingPath, stableJson(words.map(word => ({
          word: String(word.word),
          startMs: Number(word.start_ms),
          endMs: Number(word.end_ms),
          confidence: Number(word.confidence),
          timingMethod: String(word.timing_method)
        }))), 'utf8');
        this.db.raw.prepare('UPDATE voice_assets SET timing_path = ?, updated_at = ? WHERE id = ?')
          .run(timingPath, new Date().toISOString(), voice.id);
        counters.rebuiltVoiceTimings += 1;
      }

      const manifests = this.db.raw.prepare(`
        SELECT id, profile, manifest_json FROM render_manifests WHERE project_id = ? ORDER BY created_at
      `).all(projectId) as Array<Record<string, unknown>>;
      for (const row of manifests) {
        const manifest = this.decodeManifest(row.manifest_json);
        const width = Number(manifest.output?.width ?? (String(row.profile).includes('1080') ? 1920 : 1280));
        const height = Number(manifest.output?.height ?? (String(row.profile).includes('1080') ? 1080 : 720));
        for (const scene of manifest.scenes ?? []) {
          if (!scene.editingPlan || !scene.durationMs) continue;
          const priorPath = scene.editingLayerPath;
          if (priorPath && existsSync(priorPath)) continue;
          try {
            const directory = priorPath
              ? dirname(priorPath)
              : join(this.settings().projectFolder, projectId, 'editing-layers', String(row.profile));
            const layer = this.editing.prepareLayer({
              plan: scene.editingPlan,
              width,
              height,
              durationMs: Number(scene.durationMs),
              directory
            });
            if (existsSync(layer.path)) counters.rebuiltEditingLayers += 1;
          } catch (error) {
            failures.push(`editing_layer:${String(row.id)}:${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const words = (manifest.scenes ?? []).flatMap(scene => scene.wordTimings ?? []);
        const cues = captionCuesFromWords(words);
        const captionFiles = [
          { kind: 'srt', path: manifest.captions?.srtPath },
          { kind: 'vtt', path: manifest.captions?.vttPath }
        ];
        for (const caption of captionFiles) {
          if (!caption.path || existsSync(caption.path)) continue;
          if (!cues.length) {
            failures.push(`caption_${caption.kind}:${String(row.id)}:no word timings in render manifest`);
            continue;
          }
          mkdirSync(dirname(caption.path), { recursive: true });
          if (caption.kind === 'srt') {
            writeFileSync(caption.path, `${cues.map((cue, index) =>
              `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text}\n`
            ).join('\n')}\n`, 'utf8');
          } else {
            writeFileSync(caption.path, `WEBVTT\n\n${cues.map((cue, index) =>
              `${index + 1}\n${vttTime(cue.startMs)} --> ${vttTime(cue.endMs)}\n${cue.text}\n`
            ).join('\n')}\n`, 'utf8');
          }
          counters.rebuiltCaptionFiles += 1;
        }
      }

      const missingFragments = this.db.raw.prepare(`
        SELECT id, output_path FROM render_fragments WHERE project_id = ? AND status = 'ready'
      `).all(projectId) as Array<{ id: string; output_path: string }>;
      for (const fragment of missingFragments) {
        if (existsSync(fragment.output_path)) continue;
        this.db.raw.prepare(`UPDATE render_fragments SET status = 'stale', updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), fragment.id);
        counters.staleRenderFragments += 1;
      }

      const completedAt = new Date().toISOString();
      const status: DerivativeRebuildReport['status'] = missingOriginals.length || missingVoice.length || failures.length
        ? 'partial'
        : 'complete';
      this.db.raw.prepare(`
        UPDATE derivative_rebuild_runs SET checked_originals = ?, rebuilt_proxies = ?,
          rebuilt_contact_sheets = ?, rebuilt_voice_timings = ?, rebuilt_editing_layers = ?,
          rebuilt_caption_files = ?, stale_render_fragments = ?, missing_originals_json = ?,
          missing_voice_json = ?, failures_json = ?, status = ?, completed_at = ? WHERE id = ?
      `).run(
        counters.checkedOriginals,
        counters.rebuiltProxies,
        counters.rebuiltContactSheets,
        counters.rebuiltVoiceTimings,
        counters.rebuiltEditingLayers,
        counters.rebuiltCaptionFiles,
        counters.staleRenderFragments,
        JSON.stringify(missingOriginals),
        JSON.stringify(missingVoice),
        JSON.stringify(failures),
        status,
        completedAt,
        runId
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.raw.prepare(`
        UPDATE derivative_rebuild_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?
      `).run(message, new Date().toISOString(), runId);
      throw error;
    }
    return rebuildFromRow(this.db.raw.prepare('SELECT * FROM derivative_rebuild_runs WHERE id = ?').get(runId) as Record<string, unknown>);
  }

  async rebuildAllProjects(): Promise<DerivativeRebuildReport[]> {
    const projects = this.db.raw.prepare('SELECT id FROM projects ORDER BY created_at, id').all() as Array<{ id: string }>;
    const reports: DerivativeRebuildReport[] = [];
    for (const project of projects) reports.push(await this.rebuildProject(project.id));
    return reports;
  }

  private exportRows(projectId: string) {
    const all = (sql: string, ...parameters: unknown[]): Array<Record<string, unknown>> =>
      this.db.raw.prepare(sql).all(...parameters) as Array<Record<string, unknown>>;
    const project = this.db.raw.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown>;
    const assetIds = `SELECT selected_asset_id FROM project_scenes WHERE project_id = ? AND selected_asset_id IS NOT NULL
      UNION SELECT asset_id FROM acquisition_items WHERE project_id = ?
      UNION SELECT asset_id FROM project_licenses WHERE project_id = ?`;
    const fileIds = `SELECT selected_file_id FROM project_scenes WHERE project_id = ? AND selected_file_id IS NOT NULL
      UNION SELECT mapped_file_id FROM acquisition_items WHERE project_id = ? AND mapped_file_id IS NOT NULL`;
    return {
      project,
      projectGuidance: this.db.raw.prepare(`
        SELECT * FROM project_guidance WHERE project_id = ?
      `).get(projectId) as Record<string, unknown> | undefined ?? null,
      schemaMigrations: all('SELECT version, name FROM schema_migrations ORDER BY version'),
      scriptVersions: all('SELECT * FROM script_versions WHERE project_id = ? ORDER BY version_number', projectId),
      researchSources: all('SELECT * FROM research_sources WHERE project_id = ? ORDER BY id', projectId),
      factClaims: all('SELECT * FROM fact_claims WHERE project_id = ? ORDER BY id', projectId),
      factClaimSources: all(`SELECT link.* FROM fact_claim_sources link JOIN fact_claims claim ON claim.id = link.claim_id WHERE claim.project_id = ? ORDER BY link.claim_id, link.source_id`, projectId),
      projectSceneClaims: all(`SELECT link.* FROM project_scene_claims link JOIN project_scenes scene ON scene.id = link.scene_id WHERE scene.project_id = ? ORDER BY link.scene_id, link.claim_id`, projectId),
      scenes: all('SELECT * FROM project_scenes WHERE project_id = ? ORDER BY ordinal', projectId),
      shotCandidates: all('SELECT * FROM shot_candidates WHERE project_id = ? ORDER BY scene_id, candidate_rank', projectId),
      footageVerifications: all('SELECT * FROM footage_verifications WHERE project_id = ? ORDER BY created_at, id', projectId),
      places: all(`SELECT DISTINCT place.* FROM places place JOIN project_scenes scene ON scene.required_place_id = place.id WHERE scene.project_id = ? ORDER BY place.id`, projectId),
      acquisitions: all('SELECT * FROM acquisition_items WHERE project_id = ? ORDER BY ordinal', projectId),
      licenses: all('SELECT * FROM project_licenses WHERE project_id = ? ORDER BY asset_id', projectId),
      assets: all(`SELECT * FROM assets WHERE id IN (${assetIds}) ORDER BY id`, projectId, projectId, projectId),
      assetFiles: all(`SELECT * FROM asset_files WHERE id IN (${fileIds}) ORDER BY id`, projectId, projectId),
      mediaSegments: all(`SELECT segment.* FROM media_segments segment WHERE segment.asset_file_id IN (${fileIds}) ORDER BY segment.asset_file_id, segment.start_ms`, projectId, projectId),
      voiceAssets: all('SELECT * FROM voice_assets WHERE project_id = ? ORDER BY created_at, id', projectId),
      narrationSections: all('SELECT * FROM narration_sections WHERE project_id = ? ORDER BY ordinal', projectId),
      narrationWords: all(`SELECT word.* FROM narration_words word JOIN narration_sections section ON section.id = word.section_id WHERE section.project_id = ? ORDER BY section.ordinal, word.ordinal`, projectId),
      renderManifests: all('SELECT * FROM render_manifests WHERE project_id = ? ORDER BY created_at, id', projectId),
      renders: all(`SELECT * FROM renders WHERE project_id = ? ORDER BY CASE kind WHEN 'final' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, completed_at DESC, created_at DESC`, projectId),
      renderFragments: all('SELECT * FROM render_fragments WHERE project_id = ? ORDER BY created_at, id', projectId),
      qcResults: all('SELECT * FROM qc_results WHERE project_id = ? ORDER BY created_at, id', projectId),
      packagingCandidates: all('SELECT * FROM packaging_candidates WHERE project_id = ? ORDER BY ordinal', projectId),
      repairAttempts: all('SELECT * FROM repair_attempts WHERE project_id = ? ORDER BY created_at, id', projectId),
      publicationRecords: all('SELECT * FROM publication_records WHERE project_id = ? ORDER BY created_at, id', projectId),
      auditLog: all('SELECT * FROM audit_log WHERE project_id = ? ORDER BY created_at, id', projectId)
    };
  }

  private projectAssetFiles(projectId: string): Array<Record<string, unknown>> {
    return this.db.raw.prepare(`
      SELECT DISTINCT file.* FROM asset_files file
      WHERE file.id IN (
        SELECT selected_file_id FROM project_scenes WHERE project_id = ? AND selected_file_id IS NOT NULL
        UNION SELECT mapped_file_id FROM acquisition_items WHERE project_id = ? AND mapped_file_id IS NOT NULL
      ) ORDER BY file.id
    `).all(projectId, projectId) as Array<Record<string, unknown>>;
  }

  private decodeManifest(value: unknown): PortableRenderManifest {
    try {
      const decoded = JSON.parse(String(value ?? '{}'));
      return decoded && typeof decoded === 'object' ? decoded as PortableRenderManifest : {};
    } catch {
      return {};
    }
  }

  private async createProxy(ffmpeg: string, originalPath: string, proxyPath: string, audioPresent: boolean): Promise<void> {
    mkdirSync(dirname(proxyPath), { recursive: true });
    await requireSuccess(ffmpeg, [
      '-y', '-hide_banner', '-i', originalPath, '-map', '0:v:0',
      ...(audioPresent ? ['-map', '0:a:0?'] : []),
      '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30,format=yuv420p",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
      ...(audioPresent ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
      '-movflags', '+faststart', proxyPath
    ]);
  }

  private async createContactSheet(ffmpeg: string, originalPath: string, contactSheetPath: string): Promise<void> {
    mkdirSync(dirname(contactSheetPath), { recursive: true });
    await requireSuccess(ffmpeg, [
      '-y', '-hide_banner', '-i', originalPath,
      '-vf', 'fps=1/4,scale=320:-1:force_original_aspect_ratio=decrease,tile=4x3:padding=6:margin=6',
      '-frames:v', '1', contactSheetPath
    ]);
  }
}
