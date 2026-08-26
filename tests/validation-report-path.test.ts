import { describe, expect, it } from 'vitest';
import { normalizeValidationReportFile } from '../scripts/validation-report-path.mjs';

describe('validation report paths', () => {
  it('normalizes local, Linux, and Windows test report paths to the same binding', () => {
    const root = '/workspace/video';
    expect(normalizeValidationReportFile('/workspace/video/tests/workflow-service.test.ts', root))
      .toBe('tests/workflow-service.test.ts');
    expect(normalizeValidationReportFile('/home/runner/work/Video/Video/tests/workflow-service.test.ts', root))
      .toBe('tests/workflow-service.test.ts');
    expect(normalizeValidationReportFile(
      'D:\\a\\Video\\Video\\tests\\workflow-service.test.ts',
      root
    )).toBe('tests/workflow-service.test.ts');
  });
});
