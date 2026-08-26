import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import ffprobeStatic from 'ffprobe-static';
import {
  collectProductionPilotEvidence,
  listProductionPilotCandidates,
  probeMediaWithFfprobe
} from './collect-production-pilot-evidence.mjs';
import {
  PRODUCTION_PILOT_RECEIPT_PATH,
  writeProductionPilotQualificationIndex
} from './external-qualification-evidence.mjs';
import {
  admitValidationSource,
  assertValidationSourceStable
} from './validation-source.mjs';

const args = process.argv.slice(2);
await main();

async function main() {
  const mode = option('mode', 'supporting');
  if (!['supporting', 'qualification'].includes(mode)) {
    throw new Error('Production pilot mode must be supporting or qualification.');
  }

  const databasePath = option('database', process.env.VIDEOFACTORY_DATABASE_PATH ?? '').trim();
  if (!databasePath) {
    throw new Error('Production pilot qualification requires --database=<path-to-videofactory.sqlite>.');
  }
  if (args.includes('--list-candidates')) {
    process.stdout.write(`${JSON.stringify(listProductionPilotCandidates(databasePath), null, 2)}\n`);
    return;
  }
  const projectIds = option('projects', process.env.VIDEOFACTORY_PILOT_PROJECTS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (projectIds.length !== 5 || new Set(projectIds).size !== 5) {
    throw new Error('Production pilot qualification requires --projects with exactly five distinct comma-separated project IDs.');
  }

  const deviceClass = option('device-class', process.env.VIDEOFACTORY_PILOT_DEVICE_CLASS ?? '').trim();
  const output = resolve(option('output', PRODUCTION_PILOT_RECEIPT_PATH));
  const ci = truthy(process.env.CI || process.env.GITHUB_ACTIONS);
  if (mode === 'qualification') {
    if (process.platform !== 'win32' || arch() !== 'x64') {
      throw new Error('Qualification mode requires a supported Windows x64 operator workstation.');
    }
    if (ci) throw new Error('Qualification mode must run on representative operator hardware outside CI.');
    if (deviceClass.length < 8) {
      throw new Error('Qualification mode requires --device-class with a non-sensitive representative hardware description.');
    }
    if (output !== resolve(PRODUCTION_PILOT_RECEIPT_PATH)) {
      throw new Error(`Qualification mode must write ${PRODUCTION_PILOT_RECEIPT_PATH}.`);
    }
  }

  const root = process.cwd();
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const admission = admitValidationSource({
    root,
    qualification: mode === 'qualification' ? 'release' : 'development'
  });
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });

  const collected = await collectProductionPilotEvidence({
    root,
    databasePath,
    projectIds,
    mode,
    deviceClass: deviceClass || null,
    source: admission.source,
    appVersion: String(packageJson.version),
    probeMedia: path => probeMediaWithFfprobe(path, ffprobeStatic.path)
  });
  assertValidationSourceStable(admission);
  writeFileSync(output, `${JSON.stringify(collected.assessment, null, 2)}\n`, 'utf8');
  assertValidationSourceStable(admission);

  if (!collected.assessment.fieldCriteriaPassed) {
    throw new Error('Production pilot field criteria failed. Inspect the generated receipt for project-level checks.');
  }
  if (mode === 'qualification' && !collected.assessment.externalQualificationPassed) {
    throw new Error('Production pilot target run did not satisfy every external qualification condition.');
  }
  const externalAdmission = mode === 'qualification'
    ? writeProductionPilotQualificationIndex({ root, source: admission.source })
    : null;
  assertValidationSourceStable(admission);

  process.stdout.write(
    `Production pilot ${mode} run passed for ${projectIds.length} projects across `
    + `${collected.assessment.derived.destinationClusterCount} destination clusters; `
    + `external qualification: ${collected.assessment.externalQualificationPassed ? 'passed' : 'not claimed'}.\n`
    + `Receipt: ${output}\n`
    + (externalAdmission?.index ? `Index: ${resolve(externalAdmission.index.path)}\n` : '')
  );
}

function option(name, fallback) {
  const inline = args.find(argument => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? '' : fallback;
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}
