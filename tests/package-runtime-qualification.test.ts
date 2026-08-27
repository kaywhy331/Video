import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PACKAGE_RUNTIME_QUALIFICATION_SCHEMA_VERSION,
  PackageRuntimeQualificationRecorder,
  type PackageRuntimeQualificationEvent
} from '@main/package-runtime-qualification';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('packaged runtime qualification recorder', () => {
  it('is inert outside an explicitly opted-in packaged application', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-runtime-recorder-'));
    roots.push(root);
    expect(new PackageRuntimeQualificationRecorder({
      dataRoot: root,
      isPackaged: false,
      environmentFlag: '1'
    }).enabled).toBe(false);
    expect(new PackageRuntimeQualificationRecorder({
      dataRoot: root,
      isPackaged: true,
      environmentFlag: '0'
    }).path).toBeNull();
  });

  it('records ordered main-process observations for an opted-in package smoke', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-runtime-recorder-'));
    roots.push(root);
    const recorder = new PackageRuntimeQualificationRecorder({
      dataRoot: root,
      isPackaged: true,
      environmentFlag: '1'
    });
    recorder.record('tray_ready', { available: true });
    recorder.record('window_hidden_to_tray', { visible: false, destroyed: false });

    const events = readFileSync(recorder.path!, 'utf8')
      .trim()
      .split(/\r?\n/u)
      .map(line => JSON.parse(line) as PackageRuntimeQualificationEvent);
    expect(events.map(event => event.event)).toEqual([
      'qualification_started',
      'tray_ready',
      'window_hidden_to_tray'
    ]);
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(events.every(event => event.schemaVersion === PACKAGE_RUNTIME_QUALIFICATION_SCHEMA_VERSION)).toBe(true);
  });

  it('records explicit system scope and renderer setup observations only for an opted-in package', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-system-recorder-'));
    roots.push(root);
    const recorder = new PackageRuntimeQualificationRecorder({
      dataRoot: root,
      isPackaged: true,
      environmentFlag: '0',
      systemEnvironmentFlag: '1'
    });
    recorder.recordRendererReady({
      activeView: 'settings',
      initialSetupRequired: true,
      setupReady: false,
      setupChecklistVisible: true
    });
    const events = readFileSync(recorder.path!, 'utf8')
      .trim()
      .split(/\r?\n/u)
      .map(line => JSON.parse(line) as PackageRuntimeQualificationEvent);
    expect(recorder.systemQualification).toBe(true);
    expect(events[0]?.details).toEqual({ packaged: true, scope: 'windows_system' });
    expect(events[1]?.event).toBe('renderer_ready');
  });
});
