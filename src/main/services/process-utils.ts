import { spawn } from 'node:child_process';

const PROCESS_ENV_ALLOWLIST = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'HOME', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)'
]);

type ProcessLaunchGuard = (executable: string) => void;
let processLaunchGuard: ProcessLaunchGuard | null = null;

export function installProcessLaunchGuard(guard: ProcessLaunchGuard | null): void {
  processLaunchGuard = guard;
}

export function minimalProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => (
    value !== undefined && PROCESS_ENV_ALLOWLIST.has(key.toUpperCase())
  )));
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface BinaryProcessResult {
  code: number;
  stdout: Buffer;
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
    timeoutMs?: number;
  } = {}
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      reject(new Error('Process timeout must be a positive number.'));
      return;
    }
    if (options.signal?.aborted) {
      reject(new Error('Process was aborted before launch.'));
      return;
    }
    try {
      processLaunchGuard?.(executable);
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: minimalProcessEnvironment(options.env),
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
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (abort && options.signal) options.signal.removeEventListener('abort', abort);
    };
    child.on('error', error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code: code ?? -1, stdout, stderr });
    });

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        cleanup();
        reject(new Error(`Process timed out after ${options.timeoutMs} ms.`));
      }, options.timeoutMs);
      timer.unref();
    }

    if (options.signal) {
      abort = (): void => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        cleanup();
        reject(new Error('Process was aborted.'));
      };
      options.signal.addEventListener('abort', abort, { once: true });
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

export function runProcessBinary(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<BinaryProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      reject(new Error('Process timeout must be a positive number.'));
      return;
    }
    if (options.signal?.aborted) {
      reject(new Error('Process was aborted before launch.'));
      return;
    }
    try {
      processLaunchGuard?.(executable);
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: minimalProcessEnvironment(options.env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (abort && options.signal) options.signal.removeEventListener('abort', abort);
    };
    child.on('error', error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr });
    });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        cleanup();
        reject(new Error(`Process timed out after ${options.timeoutMs} ms.`));
      }, options.timeoutMs);
      timer.unref();
    }
    if (options.signal) {
      abort = (): void => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        cleanup();
        reject(new Error('Process was aborted.'));
      };
      options.signal.addEventListener('abort', abort, { once: true });
    }
  });
}

export async function requireSuccessBinary(
  executable: string,
  args: string[],
  options: Parameters<typeof runProcessBinary>[2] = {}
): Promise<BinaryProcessResult> {
  const result = await runProcessBinary(executable, args, options);
  if (result.code !== 0) {
    throw new Error(`${executable} failed with code ${result.code}: ${result.stderr.slice(-4000)}`);
  }
  return result;
}
