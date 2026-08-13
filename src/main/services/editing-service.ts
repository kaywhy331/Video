import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppDatabase } from '../database/database';
import type { AppSettings } from '@shared/types';
import { planSceneEditing, type SceneEditingPlan } from '@shared/editing';

interface EditingSceneRow {
  id: string;
  ordinal: number;
  visual_treatment: import('@shared/types').VisualTreatment;
  chapter: string | null;
  required_country: string | null;
  required_city: string | null;
  required_location: string | null;
  required_place_id: string | null;
  latitude: number | null;
  longitude: number | null;
  accepted_claims_json: string;
}

function assTime(milliseconds: number): string {
  const total = Math.max(0, milliseconds);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const centiseconds = Math.floor((total % 1000) / 10);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

function assText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('{', '\\{')
    .replaceAll('}', '\\}')
    .replace(/\r?\n/g, '\\N')
    .replace(/\s+/g, ' ')
    .trim();
}

function filterPath(path: string): string {
  const escaped = path
    .replaceAll('\\', '/')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'");
  return `ass=filename='${escaped}'`;
}

function coordinatePoint(latitude: number, longitude: number, width: number, height: number): { x: number; y: number } {
  return {
    x: Math.round(width * (0.5 + longitude / 360)),
    y: Math.round(height * (0.5 - latitude / 180))
  };
}

function assDocument(plan: SceneEditingPlan, width: number, height: number, durationMs: number): string {
  const scale = height / 720;
  const font = (value: number): number => Math.max(12, Math.round(value * scale));
  const events: string[] = [];
  const add = (startMs: number, endMs: number, style: string, text: string): void => {
    if (endMs <= startMs || !text.trim()) return;
    events.push(`Dialogue: 0,${assTime(startMs)},${assTime(endMs)},${style},,0,0,0,,${text}`);
  };
  const whole = Math.max(500, durationMs);

  if (plan.sourceKind === 'generated_graphic') {
    const full = plan.overlays.find(overlay => overlay.placement === 'full');
    if (plan.mapMode === 'coordinate_plot' && plan.geography.latitude !== null && plan.geography.longitude !== null) {
      const point = coordinatePoint(plan.geography.latitude, plan.geography.longitude, width, height);
      add(0, whole, 'MapPin', `{\\pos(${point.x},${point.y})}●`);
      add(0, whole, 'GraphicMeta', `${plan.geography.latitude.toFixed(4)}°, ${plan.geography.longitude.toFixed(4)}°\\NVERIFIED PLACE RECORD`);
    } else if (plan.mapMode === 'hierarchy_not_to_scale') {
      const hierarchy = [plan.geography.country, plan.geography.city, plan.geography.location]
        .filter((value): value is string => Boolean(value))
        .map(assText)
        .join('   ›   ');
      add(0, whole, 'MapHierarchy', hierarchy);
      add(0, whole, 'GraphicMeta', 'PLACE HIERARCHY · SCHEMATIC, NOT TO SCALE');
    }
    if (full) {
      add(0, whole, 'GraphicTitle', assText(full.primaryText));
      if (full.secondaryText && plan.mapMode === null) add(0, whole, 'GraphicMeta', assText(full.secondaryText));
    }
  }

  for (const overlay of plan.overlays.filter(item => item.placement !== 'full')) {
    const primary = assText(overlay.primaryText);
    const secondary = overlay.secondaryText ? `\\N{\\fs${font(17)}\\c&H00F3E8A5&}${assText(overlay.secondaryText)}` : '';
    if (overlay.kind === 'chapter_card') {
      add(0, Math.min(whole, 1_500), 'Chapter', `{\\fad(100,180)}${primary}${secondary}`);
    } else if (overlay.kind === 'location_label') {
      add(0, Math.min(whole, 4_000), 'Location', `{\\fad(120,220)}${primary}${secondary}`);
    } else if (overlay.kind === 'lower_third') {
      add(Math.min(1_500, Math.max(0, whole - 500)), Math.min(whole, 5_500), 'LowerThird', `{\\fad(140,220)}${primary}${secondary}`);
    } else if (overlay.kind === 'logo') {
      add(0, whole, 'Logo', primary);
    } else if (overlay.kind === 'data_callout') {
      add(Math.min(1_700, Math.max(0, whole - 600)), Math.max(500, whole - 250), 'Callout', `{\\fad(150,180)}{\\fs${font(16)}\\c&H00F9E867&}SOURCED FACT\\N{\\fs${font(20)}\\c&H00FAF8F8&}${primary}`);
    }
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: GraphicTitle,Arial,${font(50)},&H00FAF8F8,&H00FAF8F8,&H0007111B,&H0007111B,-1,0,0,0,100,100,0,0,1,2,0,7,${Math.round(width * 0.07)},${Math.round(width * 0.07)},${Math.round(height * 0.09)},1`,
    `Style: GraphicMeta,Arial,${font(19)},&H00F3E8A5,&H00F3E8A5,&H0007111B,&H0007111B,-1,0,0,0,100,100,1,0,1,1,0,1,${Math.round(width * 0.07)},${Math.round(width * 0.07)},${Math.round(height * 0.08)},1`,
    `Style: MapHierarchy,Arial,${font(27)},&H00FAF8F8,&H00FAF8F8,&H0007111B,&H0007111B,-1,0,0,0,100,100,0,0,3,2,0,5,${Math.round(width * 0.08)},${Math.round(width * 0.08)},0,1`,
    `Style: MapPin,Arial,${font(52)},&H00F9E867,&H00F9E867,&H004A3A1E,&H0007111B,-1,0,0,0,100,100,0,0,1,2,0,5,0,0,0,1`,
    `Style: Chapter,Arial,${font(45)},&H00FAF8F8,&H00FAF8F8,&H0007111B,&H3007111B,-1,0,0,0,100,100,0,0,3,2,0,5,${Math.round(width * 0.12)},${Math.round(width * 0.12)},0,1`,
    `Style: Location,Arial,${font(25)},&H00FAF8F8,&H00FAF8F8,&H0007111B,&H3007111B,-1,0,0,0,100,100,0,0,3,1,0,7,${Math.round(width * 0.035)},${Math.round(width * 0.5)},${Math.round(height * 0.045)},1`,
    `Style: LowerThird,Arial,${font(26)},&H00FAF8F8,&H00FAF8F8,&H0007111B,&H2807111B,-1,0,0,0,100,100,0,0,3,1,0,1,${Math.round(width * 0.035)},${Math.round(width * 0.48)},${Math.round(height * 0.07)},1`,
    `Style: Logo,Arial,${font(16)},&H00E2E8F0,&H00E2E8F0,&H0007111B,&H5007111B,-1,0,0,0,100,100,1,0,3,1,0,9,${Math.round(width * 0.78)},${Math.round(width * 0.035)},${Math.round(height * 0.045)},1`,
    `Style: Callout,Arial,${font(20)},&H00FAF8F8,&H00FAF8F8,&H0007111B,&H2007111B,0,0,0,0,100,100,0,0,3,1,0,3,${Math.round(width * 0.55)},${Math.round(width * 0.035)},${Math.round(height * 0.07)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    ''
  ].join('\n');
}

export class EditingService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings
  ) {}

  plan(projectId: string, sceneId: string): SceneEditingPlan {
    const row = this.db.raw.prepare(`
      SELECT s.id, s.ordinal, s.visual_treatment, s.chapter,
        s.required_country, s.required_city, s.required_location,
        s.required_place_id, p.latitude, p.longitude,
        coalesce((
          SELECT json_group_array(json_object('id', c.id, 'text', c.text))
          FROM project_scene_claims link
          JOIN fact_claims c ON c.id = link.claim_id
          WHERE link.scene_id = s.id AND c.status = 'accepted'
            AND c.category <> 'visual_observation'
        ), '[]') AS accepted_claims_json
      FROM project_scenes s
      LEFT JOIN places p ON p.id = s.required_place_id
      WHERE s.project_id = ? AND s.id = ?
    `).get(projectId, sceneId) as unknown as EditingSceneRow | undefined;
    if (!row) throw new Error('Scene not found for deterministic editing plan.');
    const previous = this.db.raw.prepare(`
      SELECT chapter FROM project_scenes WHERE project_id = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT 1
    `).get(projectId, row.ordinal) as { chapter: string | null } | undefined;
    let claims: Array<{ id: string; text: string }> = [];
    try {
      const parsed = JSON.parse(row.accepted_claims_json);
      if (Array.isArray(parsed)) claims = parsed.filter(item => item && typeof item.id === 'string' && typeof item.text === 'string');
    } catch {
      claims = [];
    }
    return planSceneEditing({
      sceneId: row.id,
      ordinal: row.ordinal,
      visualTreatment: row.visual_treatment,
      chapter: row.chapter,
      previousChapter: previous?.chapter ?? null,
      country: row.required_country,
      city: row.required_city,
      location: row.required_location,
      requiredPlaceId: row.required_place_id,
      latitude: row.latitude,
      longitude: row.longitude,
      acceptedClaims: claims,
      channelName: this.settings().channelName,
      channelShort: this.settings().channelShort
    });
  }

  prepareLayer(input: {
    plan: SceneEditingPlan;
    width: number;
    height: number;
    durationMs: number;
    directory: string;
  }): { path: string; filter: string; hash: string } {
    mkdirSync(input.directory, { recursive: true });
    const hash = createHash('sha256').update(JSON.stringify({
      plan: input.plan,
      width: input.width,
      height: input.height,
      durationMs: input.durationMs
    })).digest('hex');
    const path = join(input.directory, `${hash}.ass`);
    if (!existsSync(path)) writeFileSync(path, assDocument(input.plan, input.width, input.height, input.durationMs), 'utf8');
    return { path, filter: filterPath(path), hash };
  }
}
