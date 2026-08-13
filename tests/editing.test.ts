import { describe, expect, it } from 'vitest';
import { planSceneEditing } from '@shared/editing';

describe('deterministic editing plans', () => {
  it('builds a source-bound map, location, chapter, lower-third, logo, and data plan', () => {
    const input = {
      sceneId: 'scene-1',
      ordinal: 1,
      visualTreatment: 'MAP_OR_GRAPHIC' as const,
      chapter: 'Arrival',
      previousChapter: null,
      country: 'Mexico',
      city: 'Oaxaca',
      location: 'Zocalo',
      requiredPlaceId: 'place-1',
      latitude: 17.0608,
      longitude: -96.7253,
      acceptedClaims: [{ id: 'claim-1', text: 'The plaza anchors the historic center.' }],
      channelName: 'Grounded Travel',
      channelShort: 'TRAVEL'
    };
    const first = planSceneEditing(input);
    const second = planSceneEditing(input);

    expect(first).toEqual(second);
    expect(first.sourceKind).toBe('generated_graphic');
    expect(first.mapMode).toBe('coordinate_plot');
    expect(first.overlays.map(overlay => overlay.kind)).toEqual([
      'map_card', 'location_label', 'chapter_card', 'lower_third', 'logo', 'data_callout'
    ]);
    expect(first.overlays.at(-1)?.evidenceIds).toEqual(['claim-1']);
  });

  it('uses an explicit not-to-scale hierarchy card when coordinates are absent', () => {
    const plan = planSceneEditing({
      sceneId: 'scene-2',
      ordinal: 2,
      visualTreatment: 'MAP_OR_GRAPHIC',
      chapter: 'Context',
      previousChapter: 'Arrival',
      country: 'Mexico',
      city: 'Oaxaca',
      location: null,
      requiredPlaceId: 'place-2',
      latitude: null,
      longitude: null,
      acceptedClaims: [],
      channelName: '',
      channelShort: ''
    });

    expect(plan.mapMode).toBe('hierarchy_not_to_scale');
    expect(plan.overlays[0]).toMatchObject({
      kind: 'map_card',
      secondaryText: 'Place hierarchy · schematic, not to scale'
    });
    expect(plan.overlays.some(overlay => overlay.kind === 'chapter_card')).toBe(true);
  });
});
