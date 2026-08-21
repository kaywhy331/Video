import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import type { AppDatabase } from '../database/database';
import { SettingsPatchSchema } from '@shared/contracts';
import type { AppSettings, SettingsProfileReport, UpdateCheckResult } from '@shared/types';

interface ReleaseRecord {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function versionParts(value: string): Array<number | string> {
  const match = value.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return [];
  return [Number(match[1]), Number(match[2]), Number(match[3]), ...(match[4]?.split('.') ?? [])];
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  if (a.length < 3 || b.length < 3) return 0;
  for (let index = 0; index < 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return Math.sign(difference);
  }
  const aPre = a.slice(3);
  const bPre = b.slice(3);
  if (!aPre.length && !bPre.length) return 0;
  if (!aPre.length) return 1;
  if (!bPre.length) return -1;
  for (let index = 0; index < Math.max(aPre.length, bPre.length); index += 1) {
    const leftPart = aPre[index];
    const rightPart = bPre[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = typeof leftPart === 'number' || /^\d+$/.test(String(leftPart));
    const rightNumber = typeof rightPart === 'number' || /^\d+$/.test(String(rightPart));
    if (leftNumber && rightNumber) return Math.sign(Number(leftPart) - Number(rightPart));
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return String(leftPart).localeCompare(String(rightPart));
  }
  return 0;
}

function safeReleaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

export class SettingsProfileService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly update: (patch: Partial<AppSettings>) => Promise<AppSettings>,
    private readonly appVersion: string
  ) {}

  export(path: string): SettingsProfileReport {
    const current = this.settings();
    const portable: Partial<AppSettings> = { ...current };
    delete portable.databasePath;
    delete portable.dataRoot;
    const payload = {
      schemaVersion: 1,
      product: 'VideoFactory Desktop',
      appVersion: this.appVersion,
      exportedAt: new Date().toISOString(),
      secretsIncluded: false,
      settings: portable
    };
    const encoded = `${JSON.stringify(payload, null, 2)}\n`;
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp`;
    writeFileSync(temporaryPath, encoded, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, path);
    const digest = sha256(encoded);
    const appliedKeys = Object.keys(portable).sort();
    const warnings = ['Credentials, OAuth tokens, the active database path, and the data-root path are intentionally excluded.'];
    this.record('export', path, digest, appliedKeys, warnings);
    return { operation: 'export', path, sha256: digest, appliedKeys, warnings, settings: current };
  }

  async import(path: string): Promise<SettingsProfileReport> {
    if (statSync(path).size > 2 * 1024 * 1024) throw new Error('Settings profile exceeds the 2 MB safety limit.');
    const encoded = readFileSync(path, 'utf8');
    const decoded = JSON.parse(encoded) as Record<string, unknown>;
    if (decoded.schemaVersion !== 1 || decoded.product !== 'VideoFactory Desktop') {
      throw new Error('This is not a supported VideoFactory settings profile.');
    }
    if (!decoded.settings || typeof decoded.settings !== 'object' || Array.isArray(decoded.settings)) {
      throw new Error('Settings profile does not contain a settings object.');
    }
    const candidate = { ...(decoded.settings as Record<string, unknown>) };
    const warnings: string[] = [];
    for (const protectedKey of ['databasePath', 'dataRoot']) {
      if (protectedKey in candidate) {
        delete candidate[protectedKey];
        warnings.push(`${protectedKey} was ignored because active storage migration requires a controlled operation.`);
      }
    }
    const patch = SettingsPatchSchema.parse(candidate) as Partial<AppSettings>;
    const next = await this.update(patch);
    const digest = sha256(encoded);
    const appliedKeys = Object.keys(patch).sort();
    this.record('import', path, digest, appliedKeys, warnings);
    return { operation: 'import', path, sha256: digest, appliedKeys, warnings, settings: next };
  }

  private record(
    operation: 'export' | 'import',
    path: string,
    digest: string,
    appliedKeys: string[],
    warnings: string[]
  ): void {
    this.db.raw.prepare(`
      INSERT INTO settings_profile_operations(
        id, operation, path, sha256, applied_keys_json, warnings_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), operation, path, digest,
      JSON.stringify(appliedKeys), JSON.stringify(warnings), new Date().toISOString()
    );
  }
}

export class UpdateService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly currentVersion: string,
    private readonly request: typeof fetch = fetch
  ) {}

  latest(): UpdateCheckResult | null {
    const row = this.db.raw.prepare(`SELECT * FROM update_checks ORDER BY checked_at DESC LIMIT 1`).get() as
      | Record<string, unknown>
      | undefined;
    return row ? this.fromRow(row) : null;
  }

  async check(): Promise<UpdateCheckResult> {
    const channel = this.settings().updateChannel;
    const checkedAt = new Date().toISOString();
    const endpoint = channel === 'stable'
      ? 'https://api.github.com/repos/kaywhy331/Video/releases/latest'
      : 'https://api.github.com/repos/kaywhy331/Video/releases?per_page=20';
    let latestVersion: string | null = null;
    let releaseUrl: string | null = null;
    let status: UpdateCheckResult['status'] = 'unpublished';
    let error: string | null = null;
    try {
      const response = await this.request(endpoint, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `VideoFactory-Desktop/${this.currentVersion}`,
          'x-github-api-version': '2022-11-28'
        },
        signal: AbortSignal.timeout(15_000)
      });
      if (response.status === 404) {
        status = 'unpublished';
      } else if (!response.ok) {
        throw new Error(`GitHub release check returned HTTP ${response.status}.`);
      } else {
        const body = await response.json() as ReleaseRecord | ReleaseRecord[];
        const releases = (Array.isArray(body) ? body : [body])
          .filter(item => !item.draft && (channel === 'prerelease' || !item.prerelease));
        const release = releases.find(item => typeof item.tag_name === 'string' && versionParts(item.tag_name).length >= 3);
        if (release) {
          latestVersion = String(release.tag_name).replace(/^v/i, '');
          releaseUrl = safeReleaseUrl(release.html_url);
          status = compareVersions(latestVersion, this.currentVersion) > 0 ? 'available' : 'current';
        }
      }
    } catch (caught) {
      status = 'error';
      error = caught instanceof Error ? caught.message.slice(0, 1_000) : String(caught).slice(0, 1_000);
    }
    const result: UpdateCheckResult = {
      currentVersion: this.currentVersion,
      latestVersion,
      releaseUrl,
      available: status === 'available',
      status,
      channel,
      checkedAt,
      error
    };
    this.db.raw.prepare(`
      INSERT INTO update_checks(
        id, channel, current_version, latest_version, release_url,
        available, status, error, checked_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), channel, this.currentVersion, latestVersion, releaseUrl,
      Number(result.available), status, error, checkedAt
    );
    return result;
  }

  private fromRow(row: Record<string, unknown>): UpdateCheckResult {
    return {
      currentVersion: String(row.current_version),
      latestVersion: row.latest_version ? String(row.latest_version) : null,
      releaseUrl: row.release_url ? String(row.release_url) : null,
      available: Boolean(row.available),
      status: row.status as UpdateCheckResult['status'],
      channel: row.channel as UpdateCheckResult['channel'],
      checkedAt: String(row.checked_at),
      error: row.error ? String(row.error) : null
    };
  }
}
