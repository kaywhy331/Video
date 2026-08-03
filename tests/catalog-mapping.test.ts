import { describe, expect, it } from 'vitest';
import { detectColumnMapping } from '@main/services/catalog-service';

describe('spreadsheet column mapping', () => {
  it('recognizes the production spreadsheet headings', () => {
    const mapping = detectColumnMapping([
      'ID', 'Page', 'Author', 'Attributes', 'Item Tags', 'Title', 'Description',
      'Country', 'City', 'Location', 'Activity', 'Shot', 'Scene', 'Object',
      'Time of Day', 'Style', 'Length', 'Thumbnail', 'Resolution', 'File Size',
      'Frame Rate', 'Alpha Channel', 'Looped', 'Video Encoding', 'Orientation'
    ]);
    expect(mapping.sourceRowId).toBe('ID');
    expect(mapping.canonicalPageUrl).toBe('Page');
    expect(mapping.locationName).toBe('Location');
    expect(mapping.declaredResolution).toBe('Resolution');
    expect(mapping.declaredCodec).toBe('Video Encoding');
  });
});
