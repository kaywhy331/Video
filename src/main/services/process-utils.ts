import { spawn } from 'node:child_process';

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runProcess(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    onProgress?: (line: string) => void;
    signal?: AbortSignal;
  } = {}
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      options.onProgress?.(String(chunk));
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      options.onProgress?.(String(chunk));
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));

    if (options.signal) {
      const abort = (): void => {
        child.kill('SIGTERM');
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }
  });
}

export async function requireSuccess(
  executable: string,
  args: string[],
  options: Parameters<typeof runProcess>[2] = {}
): Promise<ProcessResult> {
  const result = await runProcess(executable, args, options);
  if (result.code !== 0) {
    throw new Error(`${executable} failed with code ${result.code}: ${result.stderr.slice(-4000)}`);
  }
  return result;
}
