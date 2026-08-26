import { writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { openRenderCrashFixture } from './render-crash-fixture';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const root = resolve(requiredEnvironment('VIDEOFACTORY_RENDER_CRASH_ROOT'));
const fixture = openRenderCrashFixture(root, (_jobId, _projectId, _progress, phase) => {
  if (phase !== 'assembly') return;
  writeSync(1, 'VIDEOFACTORY_RENDER_CHECKPOINT_READY\n');
  process.kill(process.pid, 'SIGKILL');
});

await fixture.render.render('project-1', 'draft');
throw new Error('Crash fixture reached the end of render without being forcibly terminated.');
