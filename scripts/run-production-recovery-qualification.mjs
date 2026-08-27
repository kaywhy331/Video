import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { collectProductionRecoveryEvidence } from './collect-production-recovery-evidence.mjs';
import {
  PRODUCTION_RECOVERY_RECEIPT_PATH,
  writeProductionRecoveryQualificationIndex
} from './external-qualification-evidence.mjs';
import { admitValidationSource, assertValidationSourceStable } from './validation-source.mjs';

const args = process.argv.slice(2);
const mode = option('mode', 'qualification');
if (!['supporting', 'qualification'].includes(mode)) {
  throw new Error('Production recovery mode must be supporting or qualification.');
}
const output = resolve(option('output', PRODUCTION_RECOVERY_RECEIPT_PATH));
if (mode === 'qualification' && output !== resolve(PRODUCTION_RECOVERY_RECEIPT_PATH)) {
  throw new Error(`Qualification mode must write ${PRODUCTION_RECOVERY_RECEIPT_PATH}.`);
}
const observationPaths = observations();
if (observationPaths.length !== 6) {
  throw new Error('Provide exactly six raw observations with --observation=<path> or --observations=<comma-separated-paths>.');
}

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const admission = admitValidationSource({
  root,
  qualification: mode === 'qualification' ? 'release' : 'development'
});
rmSync(output, { force: true });
const collected = collectProductionRecoveryEvidence({
  observationPaths,
  source: admission.source,
  appVersion: String(packageJson.version),
  mode
});
assertValidationSourceStable(admission);

mkdirSync(dirname(output), { recursive: true });
const temporaryPath = `${output}.tmp`;
rmSync(temporaryPath, { force: true });
writeFileSync(temporaryPath, `${JSON.stringify(collected.receipt, null, 2)}\n`, 'utf8');
renameSync(temporaryPath, output);
assertValidationSourceStable(admission);

const externalAdmission = mode === 'qualification'
  ? writeProductionRecoveryQualificationIndex({ root, source: admission.source })
  : null;
assertValidationSourceStable(admission);

process.stdout.write(
  `Production recovery ${mode} collection passed all ${collected.assessment.observationCount} forced-restart drills; `
  + `external qualification: ${collected.assessment.externalQualificationPassed ? 'passed' : 'not claimed'}.\n`
  + `Receipt: ${output}\n`
  + (externalAdmission?.index ? `Index: ${resolve(externalAdmission.index.path)}\n` : '')
);

function observations() {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith('--observation=')) {
      values.push(argument.slice('--observation='.length));
    } else if (argument === '--observation') {
      values.push(args[index + 1] ?? '');
      index += 1;
    } else if (argument.startsWith('--observations=')) {
      values.push(...argument.slice('--observations='.length).split(','));
    } else if (argument === '--observations') {
      values.push(...String(args[index + 1] ?? '').split(','));
      index += 1;
    }
  }
  return values.map(value => value.trim()).filter(Boolean).map(value => resolve(value));
}

function option(name, fallback) {
  const inline = args.find(argument => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? '' : fallback;
}
