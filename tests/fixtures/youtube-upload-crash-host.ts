import { resolve } from 'node:path';
import {
  openUploadCrashFixture,
  type UploadCrashMode
} from './youtube-upload-crash-fixture';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const root = resolve(requiredEnvironment('VIDEOFACTORY_UPLOAD_CRASH_ROOT'));
const mode = requiredEnvironment('VIDEOFACTORY_UPLOAD_CRASH_MODE');
if (!['session_persisted', 'remote_committed'].includes(mode)) {
  throw new Error(`Unsupported upload crash mode: ${mode}`);
}

const fixture = openUploadCrashFixture(root, mode as UploadCrashMode);
await fixture.workflow.uploadPrivate('project-1');
throw new Error(`Upload crash fixture reached the end of ${mode} without being forcibly terminated.`);
