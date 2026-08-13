import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppDatabase } from '../database/database';
import type { AppSettings, NarrationSection } from '@shared/types';
import {
  applicablePronunciations,
  planNarrationSections,
  type AlignedWord
} from '@shared/narration';
import type { ProjectService } from './project-service';
import type { TtsService } from './tts-service';

interface SceneRow {
  id: string;
  ordinal: number;
  chapter: string | null;
  narration: string;
  target_duration_ms: number;
  pronunciation_json: string;
}

function parseDictionary(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [key, String(item)]))
      : {};
  } catch {
    return {};
  }
}

function tokens(value: string): string[] {
  return value.match(/\S+/g) ?? [];
}

export class NarrationService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly tts: TtsService,
    private readonly projects: ProjectService
  ) {}

  async generate(projectId: string): Promise<NarrationSection[]> {
    const project = this.db.raw.prepare(`
      SELECT id, state, script_version_id FROM projects WHERE id = ?
    `).get(projectId) as {
      id: string;
      state: import('@shared/types').ProjectState;
      script_version_id: string | null;
    } | undefined;
    if (!project) throw new Error('Project not found for narration generation.');
    if (project.state !== 'GENERATING_VOICE') {
      throw new Error(`Narration can only be generated from GENERATING_VOICE, not ${project.state}.`);
    }
    if (!project.script_version_id) throw new Error('Project has no final script version.');
    const scriptVersionId = project.script_version_id;
    const script = this.db.raw.prepare(`
      SELECT script_type, locked FROM script_versions WHERE id = ?
    `).get(scriptVersionId) as { script_type: string; locked: number } | undefined;
    if (!script || script.script_type !== 'final' || !script.locked) {
      throw new Error('Narration requires a locked final script version.');
    }
    if (!this.tts.configured()) throw new Error('The configured narration provider is missing its encrypted credential.');

    const rows = this.db.raw.prepare(`
      SELECT id, ordinal, chapter, narration, target_duration_ms, pronunciation_json
      FROM project_scenes WHERE project_id = ? ORDER BY ordinal
    `).all(projectId) as unknown as SceneRow[];
    const sections = planNarrationSections(rows.map(row => ({
      id: row.id,
      chapter: row.chapter,
      narration: row.narration,
      targetDurationMs: row.target_duration_ms
    })));
    const voiceDirectory = join(this.settings().projectFolder, projectId, 'voice');
    mkdirSync(voiceDirectory, { recursive: true });
    const results: NarrationSection[] = [];
    const prepared: Array<{
      section: (typeof sections)[number];
      pronunciation: Record<string, string>;
      synthesis: Awaited<ReturnType<TtsService['synthesize']>>;
    }> = [];

    for (const section of sections) {
      const sceneRows = section.scenes.map(scene => rows.find(row => row.id === scene.id)!).filter(Boolean);
      const scenePronunciations = Object.assign({}, ...sceneRows.map(scene => parseDictionary(scene.pronunciation_json)));
      const pronunciation = {
        ...applicablePronunciations(section.text, this.settings().pronunciationDictionary),
        ...scenePronunciations
      };
      const outputPath = join(voiceDirectory, `section-${String(section.ordinal).padStart(3, '0')}.wav`);
      const synthesis = await this.tts.synthesize({
        projectId,
        text: section.text,
        outputPath,
        pronunciation
      });
      prepared.push({ section, pronunciation, synthesis });
    }

    this.db.raw.transaction(() => {
      for (const { section, pronunciation, synthesis } of prepared) {
      const voiceAsset = this.db.raw.prepare(`
        SELECT id FROM voice_assets WHERE project_id = ? AND input_hash = ?
      `).get(projectId, synthesis.inputHash) as { id: string } | undefined;
      if (!voiceAsset) throw new Error('Synthesized narration cache record is missing.');
      const now = new Date().toISOString();
      const existing = this.db.raw.prepare(`
        SELECT id FROM narration_sections WHERE script_version_id = ? AND ordinal = ?
      `).get(scriptVersionId, section.ordinal) as { id: string } | undefined;
      const sectionId = existing?.id ?? randomUUID();
      this.db.raw.prepare(`
        INSERT INTO narration_sections(
          id, project_id, script_version_id, voice_asset_id, ordinal, chapter,
          scene_ids_json, text, pronunciation_json, duration_ms, status,
          created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
        ON CONFLICT(script_version_id, ordinal) DO UPDATE SET
          voice_asset_id = excluded.voice_asset_id, chapter = excluded.chapter,
          scene_ids_json = excluded.scene_ids_json, text = excluded.text,
          pronunciation_json = excluded.pronunciation_json,
          duration_ms = excluded.duration_ms, status = 'ready', updated_at = excluded.updated_at
      `).run(
        sectionId,
        projectId,
        scriptVersionId,
        voiceAsset.id,
        section.ordinal,
        section.chapter,
        JSON.stringify(section.scenes.map(scene => scene.id)),
        section.text,
        JSON.stringify(pronunciation),
        synthesis.durationMs,
        now,
        now
      );
      this.db.raw.prepare(`DELETE FROM narration_words WHERE section_id = ?`).run(sectionId);

      const sceneWordCounts = section.scenes.map(scene => tokens(scene.narration).length);
      const expectedCount = sceneWordCounts.reduce((sum, count) => sum + count, 0);
      if (synthesis.wordTimings.length !== expectedCount) {
        throw new Error(`Narration section ${section.ordinal} timing token count does not match its final script.`);
      }
      const insertWord = this.db.raw.prepare(`
        INSERT INTO narration_words(
          id, section_id, scene_id, ordinal, word, start_ms, end_ms,
          confidence, timing_method
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let offset = 0;
      synthesis.wordTimings.forEach((word, wordIndex) => {
        while (offset < sceneWordCounts.length - 1 && wordIndex >= sceneWordCounts.slice(0, offset + 1).reduce((sum, count) => sum + count, 0)) offset += 1;
        const sceneId = section.scenes[offset]?.id;
        if (!sceneId) throw new Error('Narration timing could not be assigned to a final script scene.');
        insertWord.run(
          randomUUID(),
          sectionId,
          sceneId,
          wordIndex + 1,
          word.word,
          word.startMs,
          word.endMs,
          word.confidence,
          word.timingMethod
        );
      });
      results.push({
        id: sectionId,
        projectId,
        scriptVersionId,
        ordinal: section.ordinal,
        chapter: section.chapter,
        sceneIds: section.scenes.map(scene => scene.id),
        text: section.text,
        pronunciation,
        audioPath: synthesis.audioPath,
        timingPath: synthesis.timingPath,
        durationMs: synthesis.durationMs,
        timingMethod: synthesis.timingMethod,
        status: 'ready'
      });
      }

      this.db.raw.prepare(`
        UPDATE narration_sections SET status = 'stale', updated_at = ?
        WHERE project_id = ? AND script_version_id <> ? AND status = 'ready'
      `).run(new Date().toISOString(), projectId, scriptVersionId);
    })();

    const wordCount = Number((this.db.raw.prepare(`
      SELECT count(*) AS count FROM narration_words w
      JOIN narration_sections n ON n.id = w.section_id
      WHERE n.project_id = ? AND n.script_version_id = ? AND n.status = 'ready'
    `).get(projectId, scriptVersionId) as { count: number }).count);
    if (!wordCount) throw new Error('Narration generation produced no word-level timing records.');
    this.projects.states.transition(projectId, 'BUILDING_TIMELINE', {
      progress: 0.59,
      reason: 'Section narration, pronunciation, and word timing are ready',
      prerequisites: { sectionCount: results.length, wordCount, scriptVersionId }
    });
    return results;
  }

  wordsForScene(sceneId: string): AlignedWord[] {
    return (this.db.raw.prepare(`
      SELECT w.word, w.start_ms, w.end_ms, w.confidence, w.timing_method
      FROM narration_words w
      JOIN narration_sections n ON n.id = w.section_id
      WHERE w.scene_id = ? AND n.status = 'ready'
      ORDER BY w.ordinal
    `).all(sceneId) as Array<Record<string, unknown>>).map(row => ({
      word: String(row.word),
      startMs: Number(row.start_ms),
      endMs: Number(row.end_ms),
      confidence: Number(row.confidence),
      timingMethod: row.timing_method as AlignedWord['timingMethod']
    }));
  }
}
