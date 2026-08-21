import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { validationInputDigest } from './validation-input.mjs';

const root = process.cwd();
const resultsDirectory = resolve(root, 'validation', 'results');
const pipelinePath = resolve(resultsDirectory, 'pipeline.json');
const receiptPath = resolve(root, 'VALIDATION_ACCEPTANCE_RECEIPT.json');
const statusPath = resolve(root, 'VALIDATION_STATUS.json');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
mkdirSync(resultsDirectory, { recursive: true });
for (const name of ['pipeline.json', 'vitest.json', 'playwright.json']) {
  rmSync(resolve(resultsDirectory, name), { force: true });
}
rmSync(receiptPath, { force: true });

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const stages = [
  { name: 'typecheck', command: npm, args: ['run', 'typecheck'] },
  { name: 'vitest', command: npm, args: ['run', 'test'] },
  { name: 'build', command: npm, args: ['run', 'build'] },
  { name: 'electron_e2e', command: process.execPath, args: ['scripts/run-electron-e2e.mjs'] }
];
const input = validationInputDigest(root);
const startedAt = new Date().toISOString();
const results = [];
writeStatus('running');

for (const stage of stages) {
  const stageStartedAt = new Date().toISOString();
  const result = spawnSync(stage.command, stage.args, { cwd: root, stdio: 'inherit' });
  results.push({
    name: stage.name,
    command: [stage.command, ...stage.args].join(' '),
    startedAt: stageStartedAt,
    completedAt: new Date().toISOString(),
    status: result.status === 0 && !result.error ? 'passed' : 'failed',
    exitCode: result.status ?? null,
    ...(result.error ? { error: result.error.message } : {})
  });
  if (result.status !== 0 || result.error) {
    writePipeline({ startedAt, input, results, completed: false });
    writeStatus('failed', result.error?.message ?? `Stage ${stage.name} exited with ${result.status ?? 'no status'}.`);
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }
}

const completedInput = validationInputDigest(root);
if (completedInput.sha256 !== input.sha256) {
  results.push({
    name: 'input_stability',
    command: 'validation input digest comparison',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: 'failed',
    exitCode: 1,
    error: 'Validation inputs changed while the validation pipeline was running.'
  });
  writePipeline({ startedAt, input, results, completed: false });
  writeStatus('failed', 'Validation inputs changed while the validation pipeline was running.');
  process.exit(1);
}

writePipeline({ startedAt, input, results, completed: true });
const receipt = spawnSync(process.execPath, [
  'scripts/validate-acceptance.mjs',
  '--record-validated'
], { cwd: root, stdio: 'inherit' });
if (receipt.error) console.error(receipt.error.message);
if (receipt.status !== 0 || receipt.error) {
  writeStatus(
    'failed',
    receipt.error?.message ?? `Acceptance receipt validation exited with ${receipt.status ?? 'no status'}.`
  );
}
process.exit(receipt.status ?? 1);

function writePipeline(value) {
  const payload = {
    generatedAt: new Date().toISOString(),
    inputSha256: value.input.sha256,
    inputFileCount: value.input.fileCount,
    startedAt: value.startedAt,
    completed: value.completed,
    stages: value.results
  };
  const temporary = `${pipelinePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(temporary, pipelinePath);
}

function writeStatus(status, error) {
  const payload = {
    generatedAt: new Date().toISOString(),
    release: packageJson.version,
    validationInputSha256: input.sha256,
    pipeline: {
      status,
      report: 'validation/results/pipeline.json',
      stages: results.map(stage => ({
        name: stage.name,
        status: stage.status,
        exitCode: stage.exitCode,
        completedAt: stage.completedAt
      })),
      ...(error ? { error } : {})
    },
    acceptance: {
      receipt: null,
      status: status === 'failed' ? 'not_recorded_due_to_failed_pipeline' : 'pending'
    },
    production_ready: false
  };
  const temporary = `${statusPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(temporary, statusPath);
}
