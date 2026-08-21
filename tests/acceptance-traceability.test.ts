import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('PRD acceptance traceability', () => {
  it('maps every acceptance ID once to existing automated or external evidence', () => {
    const result = spawnSync(process.execPath, ['scripts/validate-acceptance.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Acceptance traceability passed: \d+ IDs mapped/);
  });
});
