import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['sbom', '--sbom-format=cyclonedx'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || 'npm sbom failed without diagnostic output.\n');
  process.exit(result.status ?? 1);
}

const parsed = JSON.parse(result.stdout);
if (parsed.bomFormat !== 'CycloneDX' || !Array.isArray(parsed.components)) {
  throw new Error('npm returned an invalid CycloneDX SBOM.');
}

const releaseFolder = resolve(root, 'release');
const outputPath = resolve(releaseFolder, 'videofactory-sbom.cdx.json');
mkdirSync(releaseFolder, { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(parsed, null, 2)}\n`);
console.log(`CycloneDX SBOM written with ${parsed.components.length} components: ${outputPath}`);
