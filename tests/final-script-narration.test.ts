import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { ScriptFinalizationService } from '@main/services/script-finalization-service';
import { NarrationService } from '@main/services/narration-service';
import { ProjectStateService } from '@main/services/project-state-service';
import type { AppSettings, NarrationWord } from '@shared/types';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-final-script-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, destination, state, progress,
      envato_project_name, target_duration_ms, script_version_id,
      created_at, updated_at
    ) VALUES('p1', 1, 'oaxaca', 'Oaxaca', 'Oaxaca', 'Oaxaca',
      'FINALIZING_SCRIPT', 0.53, 'YT-P1', 300000, 'script-1', ?, ?)
  `).run(now, now);
  db.raw.prepare(`
    INSERT INTO script_versions(
      id, project_id, version_number, title, topic, summary, script_json,
      generation_reason, provider, model, input_hash, locked, created_at
    ) VALUES('script-1', 'p1', 1, 'Oaxaca', 'Oaxaca', 'Provisional', ?,
      'test', 'mock', 'mock', 'input-1', 0, ?)
  `).run(JSON.stringify({ title: 'Oaxaca', scenes: [] }), now);
  db.raw.prepare(`
    INSERT INTO assets(
      id, stable_key, title, country, city, location_name, orientation,
      location_granularity, location_confidence, verification_status,
      availability_status, raw_row_json, imported_at, updated_at
    ) VALUES('asset-1', 'asset-1', 'Oaxaca plaza', 'Mexico', 'Oaxaca',
      'Zocalo', 'landscape', 'landmark', 1, 'human_verified', 'available',
      '{}', ?, ?)
  `).run(now, now);
  db.raw.prepare(`
    INSERT INTO asset_files(
      id, asset_id, sha256, original_path, original_file_name, file_size_bytes,
      duration_ms, width, height, frame_rate, codec, audio_present,
      raw_ffprobe_json, pipeline_version, created_at
    ) VALUES('file-1', 'asset-1', 'sha-1', ?, 'clip.mp4', 1000,
      8000, 1920, 1080, 30, 'h264', 0, '{}', 'test', ?)
  `).run(process.execPath, now);
  db.raw.prepare(`
    INSERT INTO media_segments(
      id, asset_file_id, start_ms, end_ms, duration_ms, quality_score,
      black_frame_risk, freeze_risk, effective_width, effective_height,
      eligible_1080p, eligible_4k, pipeline_version, created_at
    ) VALUES('segment-1', 'file-1', 0, 7000, 7000, 1,
      0, 0, 1920, 1080, 1, 0, 'test', ?)
  `).run(now);
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    db.raw.prepare(`
      INSERT INTO project_scenes(
        id, project_id, script_version_id, ordinal, chapter, narration,
        target_duration_ms, required_country, required_city, required_location,
        required_granularity, required_objects_json, required_activities_json,
        preferred_shots_json, visual_treatment, selected_asset_id,
        selected_file_id, selected_segment_id, score_explanation_json,
        verification_state, created_at, updated_at
      ) VALUES(?, 'p1', 'script-1', ?, 'Opening', ?, 4000,
        'Mexico', 'Oaxaca', 'Zocalo', 'landmark', '[]', '[]', '[]',
        'EXACT_LOCATION_FOOTAGE', 'asset-1', 'file-1', 'segment-1', '[]',
        'verified', ?, ?)
    `).run(`scene-${ordinal}`, ordinal, `Oaxaca view number ${ordinal}.`, now, now);
  }
  const settings = {
    llmProvider: 'mock',
    llmModel: 'mock',
    pronunciationDictionary: { Oaxaca: 'wah-HAH-kah' },
    projectFolder: join(root, 'projects')
  } as unknown as AppSettings;
  const states = new ProjectStateService(db);
  const projects = { states } as never;
  return { root, db, settings, projects };
}

describe('verified-footage final script and narration', () => {
  it('parents and locks a final script, preserving scene IDs and pronunciation notes', async () => {
    const { db, settings, projects } = fixture();
    const finalizeScript = vi.fn(async (input: { scenes: Array<{ id: string; narration: string }> }) => ({
      scenes: input.scenes.map(scene => ({
        sceneId: scene.id,
        narration: scene.narration,
        pronunciation: { Oaxaca: 'wah-HAH-kah' }
      }))
    }));
    const service = new ScriptFinalizationService(
      db,
      () => settings,
      { finalizeScript } as never,
      projects
    );

    const finalId = await service.finalize('p1');

    expect(finalId).not.toBe('script-1');
    expect(db.raw.prepare(`
      SELECT parent_id, version_number, script_type, locked, locked_at
      FROM script_versions WHERE id = ?
    `).get(finalId)).toMatchObject({
      parent_id: 'script-1', version_number: 2, script_type: 'final', locked: 1
    });
    expect(db.raw.prepare(`SELECT script_version_id, pronunciation_json FROM project_scenes WHERE id = 'scene-1'`).get())
      .toEqual({ script_version_id: finalId, pronunciation_json: '{"Oaxaca":"wah-HAH-kah"}' });
    expect(db.raw.prepare(`SELECT state FROM projects WHERE id = 'p1'`).get()).toEqual({ state: 'GENERATING_VOICE' });
    expect(db.raw.prepare(`SELECT action FROM audit_log WHERE action = 'script.final_locked'`).get())
      .toEqual({ action: 'script.final_locked' });
    db.close();
  });

  it('persists section audio and word timing while reusing identical section synthesis', async () => {
    const { root, db, settings, projects } = fixture();
    db.raw.prepare(`
      UPDATE script_versions SET script_type = 'final', locked = 1, locked_at = ? WHERE id = 'script-1'
    `).run(new Date().toISOString());
    db.raw.prepare(`UPDATE project_scenes SET pronunciation_json = '{"Oaxaca":"wah-HAH-kah"}'`).run();
    db.raw.prepare(`UPDATE projects SET state = 'GENERATING_VOICE' WHERE id = 'p1'`).run();
    let callCount = 0;
    const synthesize = vi.fn(async (options: { text: string; outputPath: string }) => {
      callCount += 1;
      const audioPath = options.outputPath.replace('.wav', '-cached.wav');
      const timingPath = options.outputPath.replace('.wav', '-cached.timing.json');
      writeFileSync(audioPath, 'audio');
      const tokens = options.text.match(/\S+/g) ?? [];
      const wordTimings: NarrationWord[] = tokens.map((word, index) => ({
        word,
        startMs: index * 500,
        endMs: (index + 1) * 500,
        confidence: 0.95,
        timingMethod: 'provider_word'
      }));
      writeFileSync(timingPath, JSON.stringify(wordTimings));
      db.raw.prepare(`
        INSERT INTO voice_assets(
          id, project_id, provider, model, voice_id, settings_json,
          pronunciation_hash, input_hash, text, audio_path, timing_path,
          duration_ms, timing_method, status, created_at, updated_at
        ) VALUES('voice-1', 'p1', 'test', 'test', 'voice', '{}', 'pron',
          'voice-input', ?, ?, ?, ?, 'provider_word', 'ready', ?, ?)
        ON CONFLICT(project_id, input_hash) DO NOTHING
      `).run(options.text, audioPath, timingPath, wordTimings.at(-1)?.endMs ?? 0, new Date().toISOString(), new Date().toISOString());
      return {
        audioPath,
        durationMs: wordTimings.at(-1)?.endMs ?? 0,
        wordTimings,
        timingMethod: 'provider_word' as const,
        provider: 'test',
        model: 'test',
        requestId: null,
        cached: callCount > 1,
        inputHash: 'voice-input',
        timingPath
      };
    });
    const service = new NarrationService(
      db,
      () => settings,
      { configured: () => true, synthesize } as never,
      projects
    );

    const first = await service.generate('p1');
    expect(first).toHaveLength(1);
    expect(db.raw.prepare(`SELECT count(*) AS count FROM narration_words`).get()).toEqual({ count: 16 });
    expect(db.raw.prepare(`SELECT timing_method FROM voice_assets WHERE id = 'voice-1'`).get())
      .toEqual({ timing_method: 'provider_word' });
    db.raw.prepare(`UPDATE projects SET state = 'GENERATING_VOICE' WHERE id = 'p1'`).run();
    await service.generate('p1');
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(db.raw.prepare(`SELECT count(*) AS count FROM voice_assets`).get()).toEqual({ count: 1 });
    expect(db.raw.prepare(`SELECT count(*) AS count FROM narration_sections`).get()).toEqual({ count: 1 });
    db.close();
    expect(root).toBeTruthy();
  });
});
