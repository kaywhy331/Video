import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  WINDOWS_SYSTEM_RECEIPT_PATH,
  writeWindowsSystemQualificationIndex
} from './external-qualification-evidence.mjs';
import { collectWindowsSystemEvidence } from './windows-system-evidence.mjs';
import {
  admitValidationSource,
  assertValidationSourceStable
} from './validation-source.mjs';

const args = process.argv.slice(2);
const mode = option('mode', 'qualification');
if (mode !== 'qualification') {
  throw new Error('Windows system collection supports only --mode=qualification.');
}

const output = resolve(option('output', WINDOWS_SYSTEM_RECEIPT_PATH));
if (output !== resolve(WINDOWS_SYSTEM_RECEIPT_PATH)) {
  throw new Error(`Windows system qualification must write ${WINDOWS_SYSTEM_RECEIPT_PATH}.`);
}
const qualifierPath = resolve(option('qualifier', 'scripts/windows/qualify-windows-system.ps1'));
if (qualifierPath !== resolve('scripts/windows/qualify-windows-system.ps1')) {
  throw new Error('Windows system qualification must use scripts/windows/qualify-windows-system.ps1.');
}

const observationPaths = observations();
if (observationPaths.length < 3 || observationPaths.length > 10) {
  throw new Error('Provide three to ten raw observations with --observation=<path> or --observations=<comma-separated-paths>.');
}

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const admission = admitValidationSource({ root, qualification: 'release' });
rmSync(output, { force: true });
const collected = collectWindowsSystemEvidence({
  observationPaths,
  source: admission.source,
  appVersion: String(packageJson.version),
  qualifierPath
});
assertValidationSourceStable(admission);

mkdirSync(dirname(output), { recursive: true });
const temporaryPath = `${output}.tmp`;
rmSync(temporaryPath, { force: true });
writeFileSync(temporaryPath, `${JSON.stringify(collected.receipt, null, 2)}\n`, 'utf8');
renameSync(temporaryPath, output);
assertValidationSourceStable(admission);

const externalAdmission = writeWindowsSystemQualificationIndex({
  root,
  source: admission.source
});
assertValidationSourceStable(admission);

process.stdout.write(
  `Windows system qualification passed with ${collected.assessment.observationCount} independent observations `
  + `for ${collected.assessment.qualifiedGateIds.join(', ')}.\n`
  + `Receipt: ${output}\n`
  + `Index: ${resolve(externalAdmission.index.path)}\n`
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
