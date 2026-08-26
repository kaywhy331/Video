import { afterEach, describe, expect, it } from 'vitest';
import {
  installProcessLaunchGuard,
  minimalProcessEnvironment,
  runProcess
} from '@main/services/process-utils';

afterEach(() => installProcessLaunchGuard(null));

describe('bounded child-process execution', () => {
  it('keeps only allowlisted environment keys and excludes credentials', async () => {
    const environment = minimalProcessEnvironment({
      PATH: process.env.PATH,
      HOME: '/safe-home',
      VIDEOFACTORY_API_KEY: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      NODE_OPTIONS: '--inspect'
    });
    expect(environment).toEqual({ PATH: process.env.PATH, HOME: '/safe-home' });

    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { env: { PATH: process.env.PATH, HOME: '/safe-home', VIDEOFACTORY_API_KEY: 'secret' } }
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ HOME: '/safe-home' });
    expect(result.stdout).not.toContain('VIDEOFACTORY_API_KEY');
    expect(result.stdout).not.toContain('secret');
  });

  it('rejects timed-out or launch-guard-blocked processes', async () => {
    await expect(runProcess(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 0 }))
      .rejects.toThrow('positive number');
    await expect(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }))
      .rejects.toThrow('timed out');
    const controller = new AbortController();
    controller.abort();
    await expect(runProcess(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal }))
      .rejects.toThrow('aborted before launch');
    installProcessLaunchGuard(() => { throw new Error('blocked by fixture'); });
    await expect(runProcess(process.execPath, ['-e', 'process.exit(0)']))
      .rejects.toThrow('blocked by fixture');
  });
});
