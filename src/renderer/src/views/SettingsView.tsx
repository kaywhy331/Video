import { useEffect, useState } from 'react';
import {
  Check,
  Cpu,
  Folder,
  HardDrive,
  KeyRound,
  Music2,
  RefreshCw,
  Save,
  ShieldCheck,
  DatabaseBackup,
  Download,
  Upload,
  Youtube,
  Languages,
  Network,
  Sheet,
  X
} from 'lucide-react';
import type {
  AppBootstrap,
  AppSettings,
  DiagnosticsReport,
  MediaToolInspection,
  MediaToolRole,
  MediaToolState,
  ProviderEndpointId,
  ProviderEndpointState,
  ProviderEndpointTrustMode,
  YouTubeConnectionStatus
} from '@shared/types';
import { initialSetupState } from '@shared/initial-setup';
import { Button, MetricCard, Panel, StatusPill } from '../components/ui';

export function SettingsView({
  bootstrap,
  onRefresh,
  onContinue,
  setError
}: {
  bootstrap: AppBootstrap;
  onRefresh: () => Promise<void>;
  onContinue: () => void;
  setError: (message: string | null) => void;
}) {
  const [form, setForm] = useState<AppSettings>(bootstrap.settings);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(bootstrap.diagnostics);
  const [mediaTools, setMediaTools] = useState<MediaToolState[]>([]);
  const [toolInspections, setToolInspections] = useState<Partial<Record<MediaToolRole, MediaToolInspection>>>({});
  const [toolAcknowledgements, setToolAcknowledgements] = useState<Partial<Record<MediaToolRole, boolean>>>({});
  const [youtube, setYoutube] = useState<YouTubeConnectionStatus | null>(null);
  type SecretDraft = {
    llmApiKey: string;
    visionApiKey: string;
    researchApiKey: string;
    httpTtsApiKey: string;
    youtubeClientId: string;
    youtubeClientSecret: string;
    youtubeApiKey: string;
  };
  const [secrets, setSecrets] = useState<SecretDraft>({
    llmApiKey: '',
    visionApiKey: '',
    researchApiKey: '',
    httpTtsApiKey: '',
    youtubeClientId: '',
    youtubeClientSecret: '',
    youtubeApiKey: ''
  });
  const [busy, setBusy] = useState('');
  const [musicDraft, setMusicDraft] = useState({
    title: '',
    provider: '',
    licenseType: '',
    licenseReference: '',
    licenseDocumentPath: '',
    moods: '',
    tempoBpm: '',
    loopable: true,
    licenseAttested: false
  });
  const [channelDraft, setChannelDraft] = useState({ name: '', shortCode: '', defaultLanguageCode: 'en' });
  const [languageDraft, setLanguageDraft] = useState({ languageCode: '', languageName: '', voiceProvider: 'windows_sapi', voiceId: '', displayName: '' });
  const [sheetDraft, setSheetDraft] = useState({ spreadsheetId: '', sheetRange: 'Catalog!A:ZZ' });
  const [sheetOperationId, setSheetOperationId] = useState<string | null>(null);
  const [sheetCancellationRequested, setSheetCancellationRequested] = useState(false);

  useEffect(() => setForm(bootstrap.settings), [bootstrap.settings]);
  useEffect(() => setDiagnostics(bootstrap.diagnostics), [bootstrap.diagnostics]);

  useEffect(() => {
    let active = true;
    void window.videoFactory.mediaTools.list()
      .then(states => { if (active) setMediaTools(states); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [bootstrap.settings.ffmpegPath, bootstrap.settings.ffprobePath, setError]);

  useEffect(() => {
    void window.videoFactory.youtube.status().then(setYoutube).catch(() => undefined);
  }, []);

  useEffect(() => {
    const pending = youtube?.pendingAuthorization;
    if (!pending || pending.phase === 'confirmation_required') return;
    let active = true;
    const timer = window.setInterval(() => {
      void window.videoFactory.youtube.status()
        .then(status => { if (active) setYoutube(status); })
        .catch(() => undefined);
    }, 750);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [youtube?.pendingAuthorization?.pendingAuthorizationId, youtube?.pendingAuthorization?.phase]);

  async function choose(field: keyof AppSettings): Promise<void> {
    const path = await window.videoFactory.settings.choosePath({
      kind: field === 'catalogImportFile' ? 'file' : 'directory',
      title: `Choose ${field}`
    });
    if (path) setForm(current => ({ ...current, [field]: path }));
  }

  async function run(label: string, work: () => Promise<void>): Promise<void> {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  }

  async function save(): Promise<void> {
    await run('save', async () => {
      const secretPatch = Object.fromEntries(
        (Object.entries(secrets) as Array<[keyof SecretDraft, string]>)
          .filter(([, value]) => value.trim().length > 0)
      ) as Record<string, string | undefined>;
      const { ffmpegPath: _ffmpegPath, ffprobePath: _ffprobePath, ...portableForm } = form;
      const next = await window.videoFactory.settings.update(portableForm);
      if (Object.keys(secretPatch).length) {
        await window.videoFactory.settings.updateSecrets(secretPatch);
        setSecrets({ llmApiKey: '', visionApiKey: '', researchApiKey: '', httpTtsApiKey: '', youtubeClientId: '', youtubeClientSecret: '', youtubeApiKey: '' });
      }
      setForm(next);
      await onRefresh();
    });
  }

  async function chooseMediaTool(role: MediaToolRole): Promise<void> {
    const path = await window.videoFactory.settings.choosePath({
      kind: 'file',
      title: `Inspect a ${role} executable`
    });
    if (!path) return;
    await run(`tool-inspect-${role}`, async () => {
      const inspection = await window.videoFactory.mediaTools.inspect(role, path);
      setToolInspections(current => ({ ...current, [role]: inspection }));
      setToolAcknowledgements(current => ({ ...current, [role]: false }));
    });
  }

  async function trustMediaTool(role: MediaToolRole): Promise<void> {
    const inspection = toolInspections[role];
    if (!inspection || !toolAcknowledgements[role]) return;
    await run(`tool-trust-${role}`, async () => {
      await window.videoFactory.mediaTools.trust({
        role,
        path: inspection.requestedPath,
        expectedSha256: inspection.sha256,
        acknowledgePermissions: true
      });
      setToolInspections(current => ({ ...current, [role]: undefined }));
      setToolAcknowledgements(current => ({ ...current, [role]: false }));
      setMediaTools(await window.videoFactory.mediaTools.list());
      setForm(await window.videoFactory.settings.get());
      await onRefresh();
    });
  }

  async function clearMediaTool(role: MediaToolRole): Promise<void> {
    if (!window.confirm(`Clear the device-local ${role} override and trust record?`)) return;
    await run(`tool-clear-${role}`, async () => {
      await window.videoFactory.mediaTools.clear(role);
      setToolInspections(current => ({ ...current, [role]: undefined }));
      setToolAcknowledgements(current => ({ ...current, [role]: false }));
      setMediaTools(await window.videoFactory.mediaTools.list());
      setForm(await window.videoFactory.settings.get());
      await onRefresh();
    });
  }

  async function trustProviderEndpoint(provider: ProviderEndpointId): Promise<void> {
    await run(`endpoint-trust-${provider}`, async () => {
      await window.videoFactory.settings.trustProviderEndpoint(provider);
      await onRefresh();
    });
  }

  async function clearProviderEndpointTrust(provider: ProviderEndpointId): Promise<void> {
    if (!window.confirm('Clear this provider endpoint confirmation? Provider calls will stop until it is confirmed again.')) return;
    await run(`endpoint-clear-${provider}`, async () => {
      await window.videoFactory.settings.clearProviderEndpointTrust(provider);
      await onRefresh();
    });
  }

  async function removeProviderCredential(
    provider: ProviderEndpointId,
    key: 'llmApiKey' | 'visionApiKey' | 'researchApiKey' | 'httpTtsApiKey'
  ): Promise<void> {
    if (!window.confirm('Remove this encrypted provider credential from this device?')) return;
    await run(`endpoint-key-${provider}`, async () => {
      await window.videoFactory.settings.updateSecrets({ [key]: '' });
      await onRefresh();
    });
  }

  function endpoint(provider: ProviderEndpointId): ProviderEndpointState | undefined {
    return bootstrap.providerEndpoints.find(item => item.provider === provider);
  }

  async function connectYouTube(): Promise<void> {
    await run('youtube', async () => {
      setYoutube(await window.videoFactory.youtube.beginAuthorization());
    });
  }

  async function confirmYouTube(): Promise<void> {
    const pending = youtube?.pendingAuthorization;
    if (!pending?.channelId || pending.phase !== 'confirmation_required') return;
    await run('youtube-confirm', async () => {
      setYoutube(await window.videoFactory.youtube.confirmAuthorization({
        pendingAuthorizationId: pending.pendingAuthorizationId,
        expectedChannelId: pending.channelId as string,
        replaceExisting: pending.replacement
      }));
      await onRefresh();
    });
  }

  async function cancelYouTube(): Promise<void> {
    const pending = youtube?.pendingAuthorization;
    if (!pending) return;
    await run('youtube-cancel', async () => {
      setYoutube(await window.videoFactory.youtube.cancelAuthorization(pending.pendingAuthorizationId));
      await onRefresh();
    });
  }

  async function createBackup(): Promise<void> {
    await run('backup', async () => {
      const backup = await window.videoFactory.backups.create();
      window.alert(`Backup verified and saved:\n${backup.path}`);
    });
  }

  async function restoreBackup(): Promise<void> {
    await run('restore', async () => {
      await window.videoFactory.backups.restore();
    });
  }

  async function exportProfile(): Promise<void> {
    await run('profile-export', async () => {
      const report = await window.videoFactory.settings.exportProfile();
      if (report) window.alert(`Secret-free settings profile exported:\n${report.path}`);
    });
  }

  async function importProfile(): Promise<void> {
    await run('profile-import', async () => {
      const report = await window.videoFactory.settings.importProfile();
      if (!report) return;
      setForm(report.settings);
      await onRefresh();
      window.alert([
        `Applied ${report.appliedKeys.length} settings. Credentials were not imported.`,
        ...report.warnings.map(warning => `• ${warning}`)
      ].join('\n'));
    });
  }

  async function checkUpdate(): Promise<void> {
    await run('update', async () => {
      const result = await window.videoFactory.updates.check();
      await onRefresh();
      window.alert(result.available
        ? `VideoFactory ${result.latestVersion} is available. Open the release link from this panel.`
        : result.status === 'error' ? `Update check failed: ${result.error}` : 'This installation is current for the selected channel.');
    });
  }

  async function refreshCatalog(): Promise<void> {
    await run('catalog-refresh', async () => {
      const result = await window.videoFactory.catalog.refresh();
      await onRefresh();
      window.alert(result.status === 'staged'
        ? 'A catalog diff is staged in Library for operator review; no rows were committed.'
        : `Catalog refresh status: ${result.status}. ${result.validation.issues.join(' ')}`);
    });
  }

  async function cleanupStorage(): Promise<void> {
    await run('storage-cleanup', async () => {
      const report = await window.videoFactory.storage.cleanup({ trigger: 'manual' });
      await onRefresh();
      window.alert(`Derivative cleanup ${report.status}: removed ${report.removedCount} file(s), ${(report.removedBytes / 1024 ** 2).toFixed(1)} MB. Originals and licensed music were never candidates.`);
    });
  }

  async function chooseMusicLicense(): Promise<void> {
    const path = await window.videoFactory.settings.choosePath({
      kind: 'file',
      title: 'Choose music license document'
    });
    if (path) setMusicDraft(current => ({ ...current, licenseDocumentPath: path }));
  }

  async function importMusic(): Promise<void> {
    await run('music-import', async () => {
      const track = await window.videoFactory.music.import({
        title: musicDraft.title,
        provider: musicDraft.provider,
        licenseType: musicDraft.licenseType,
        licenseReference: musicDraft.licenseReference,
        licenseDocumentPath: musicDraft.licenseDocumentPath || undefined,
        moods: musicDraft.moods.split(',').map(value => value.trim()).filter(Boolean),
        tempoBpm: musicDraft.tempoBpm ? Number(musicDraft.tempoBpm) : null,
        loopable: musicDraft.loopable,
        licenseAttested: true
      });
      if (!track) return;
      setMusicDraft({
        title: '', provider: '', licenseType: '', licenseReference: '',
        licenseDocumentPath: '', moods: '', tempoBpm: '', loopable: true,
        licenseAttested: false
      });
      await onRefresh();
      window.alert(`Licensed track imported and checksum-preserved:\n${track.title}`);
    });
  }

  async function addChannel(): Promise<void> {
    await run('channel-add', async () => {
      await window.videoFactory.expansion.saveChannel({ ...channelDraft, active: true, isDefault: false });
      setChannelDraft({ name: '', shortCode: '', defaultLanguageCode: 'en' });
      await onRefresh();
    });
  }

  async function addLanguage(): Promise<void> {
    await run('language-add', async () => {
      await window.videoFactory.expansion.saveLanguage({ ...languageDraft, active: true, isDefault: false });
      setLanguageDraft({ languageCode: '', languageName: '', voiceProvider: 'windows_sapi', voiceId: '', displayName: '' });
      await onRefresh();
    });
  }

  async function stageGoogleSheet(): Promise<void> {
    const operationId = crypto.randomUUID();
    setBusy('sheets-sync');
    setSheetOperationId(operationId);
    setSheetCancellationRequested(false);
    setError(null);
    try {
      const receipt = await window.videoFactory.expansion.stageGoogleSheet({
        spreadsheetId: sheetDraft.spreadsheetId,
        sheetRange: sheetDraft.sheetRange,
        validationTemplateId: form.catalogValidationTemplateId,
        operationId
      });
      await onRefresh();
      window.alert(receipt.status === 'staged'
        ? `Read-only Sheets sync staged ${receipt.rowCount} rows. Open Library to review the exact diff; nothing was committed.`
        : `Read-only Sheets sync ${receipt.status}: ${receipt.error ?? 'no catalog changes'}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes('cancel')) setError(message);
    } finally {
      setBusy('');
      setSheetOperationId(null);
      setSheetCancellationRequested(false);
    }
  }

  async function cancelGoogleSheet(): Promise<void> {
    if (!sheetOperationId) return;
    setSheetCancellationRequested(true);
    await window.videoFactory.catalog.cancelOperation(sheetOperationId);
  }

  const freePath = diagnostics?.paths.find(path => path.key === 'Media library');
  const freeGb = freePath?.freeBytes ? Math.round(freePath.freeBytes / 1024 ** 3) : null;
  const setup = initialSetupState({ ...bootstrap, diagnostics });

  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow"><ShieldCheck size={14} /> LOCAL PRODUCTION CONFIGURATION</div>
          <h1>Keep media local, credentials encrypted, and policy explicit.</h1>
          <p>Changing a setting affects future jobs. Originals and prior manifests remain immutable.</p>
        </div>
        <Button busy={busy === 'save'} onClick={() => void save()}><Save size={16} /> Save settings</Button>
      </div>

      <div className="metric-grid">
        <MetricCard label="FFmpeg" value={diagnostics ? (diagnostics.ffmpeg.found ? 'Ready' : 'Missing') : 'Checking'} detail={diagnostics?.ffmpeg.version ?? diagnostics?.ffmpeg.error ?? 'Diagnostics are running in the background.'} icon={<Cpu size={18} />} />
        <MetricCard label="Database" value={diagnostics ? (diagnostics.database.integrity === 'ok' ? 'Healthy' : diagnostics.database.integrity) : 'Checking'} detail={diagnostics ? (diagnostics.database.walMode ? 'WAL enabled' : 'WAL disabled') : 'Waiting for the first diagnostic report.'} icon={<HardDrive size={18} />} />
        <MetricCard label="Free media storage" value={freeGb === null ? 'Unknown' : `${freeGb} GB`} detail={`Minimum ${form.minFreeDiskGb} GB`} icon={<HardDrive size={18} />} />
        <MetricCard label="YouTube" value={youtube?.authorized ? 'Connected' : 'Not connected'} detail={youtube?.channelTitle ?? 'Private-first upload'} icon={<Youtube size={18} />} />
      </div>

      <div className="settings-grid">
        {bootstrap.projects.length === 0 || !setup.ready ? (
          <Panel
            title={setup.ready ? 'Setup complete' : 'Finish first-run setup'}
            subtitle={`${setup.completedSteps} of ${setup.steps.length} autonomous-production prerequisites are ready`}
          >
            <div className="diagnostic-list" role="status" aria-label="First-run setup checklist">
              {setup.steps.map(step => (
                <div key={step.id} data-setup-step={step.id} data-complete={step.complete ? 'true' : 'false'}>
                  <Check size={14} className={step.complete ? 'good-icon' : 'bad-icon'} />
                  <div><strong>{step.label}</strong><span>{step.detail}</span></div>
                  <StatusPill value={step.complete ? 'ready' : 'action required'} />
                </div>
              ))}
            </div>
            <Button disabled={!setup.ready} onClick={onContinue}>
              <Check size={15} /> Continue to Autopilot
            </Button>
            <small>The checklist is derived from live diagnostics and configuration. It cannot be dismissed as complete.</small>
          </Panel>
        ) : null}

        <Panel title="Storage paths" subtitle="Database stays local; originals may live on a large local drive or NAS">
          <div className="settings-form">
            <PathField label="Data root" field="dataRoot" value={form.dataRoot} choose={choose} />
            <PathField label="Watched Envato folder" field="ingestFolder" value={form.ingestFolder} choose={choose} />
            <PathField label="Central media library" field="mediaLibraryFolder" value={form.mediaLibraryFolder} choose={choose} />
            <PathField label="Project records" field="projectFolder" value={form.projectFolder} choose={choose} />
            <PathField label="Rendered output" field="outputFolder" value={form.outputFolder} choose={choose} />
            <PathField label="Backups" field="backupFolder" value={form.backupFolder} choose={choose} />
          </div>
        </Panel>

        <Panel title="Media tool trust" subtitle="Bundled tools are preferred in production; custom executables require device-local inspection and confirmation">
          <div className="media-tool-list">
            {(['ffmpeg', 'ffprobe'] as const).map(role => {
              const state = mediaTools.find(item => item.role === role);
              const inspection = toolInspections[role];
              return (
                <div className="media-tool-card" key={role}>
                  <div className="media-tool-heading">
                    <div>
                      <strong>{role.toUpperCase()}</strong>
                      <span>{state?.message ?? 'Loading executable identity…'}</span>
                    </div>
                    <div className="button-row">
                      {state ? <StatusPill value={state.status.replaceAll('_', ' ')} /> : null}
                      {state ? <StatusPill value={state.source.replaceAll('_', ' ')} /> : null}
                    </div>
                  </div>
                  {state ? (
                    <div className="media-tool-identity">
                      <span><b>Active executable</b>{state.executablePath ?? 'None'}</span>
                      <span><b>Configured override</b>{state.configuredPath || 'None'}</span>
                      <span><b>Canonical override</b>{state.canonicalPath ?? 'None'}</span>
                      <span><b>SHA-256</b>{state.sha256 ?? 'Unavailable'}</span>
                      <span><b>Signature</b>{state.signature.status}{state.signature.subject ? ` · ${state.signature.subject}` : ''}</span>
                      <span><b>Version probe</b>{state.version ?? 'No custom-tool probe receipt'}</span>
                    </div>
                  ) : null}
                  {inspection ? (
                    <div className="media-tool-inspection">
                      <div className="section-label"><ShieldCheck size={14} /> Pending local confirmation</div>
                      <div className="media-tool-identity">
                        <span><b>Requested path</b>{inspection.requestedPath}</span>
                        <span><b>Canonical path</b>{inspection.canonicalPath}</span>
                        <span><b>Detected role</b>{inspection.detectedRole} · {inspection.roleMatches ? 'matches request' : 'does not match request'}</span>
                        <span><b>Size</b>{inspection.sizeBytes.toLocaleString()} bytes</span>
                        <span><b>SHA-256</b>{inspection.sha256}</span>
                        <span><b>Platform signature</b>{inspection.signature.status}{inspection.signature.subject ? ` · ${inspection.signature.subject}` : ''}</span>
                      </div>
                      <label className="checkbox-field">
                        <input
                          type="checkbox"
                          checked={Boolean(toolAcknowledgements[role])}
                          onChange={event => setToolAcknowledgements(current => ({ ...current, [role]: event.target.checked }))}
                        />
                        <span>I reviewed this canonical path and SHA-256 and understand that this executable can read and write files with my account permissions.</span>
                      </label>
                      {!inspection.executableByCurrentUser ? <small>This file is not executable by the current user and cannot be trusted.</small> : null}
                    </div>
                  ) : null}
                  <div className="button-row">
                    <Button variant="secondary" busy={busy === `tool-inspect-${role}`} onClick={() => void chooseMediaTool(role)}>
                      <Folder size={15} /> Inspect custom {role}
                    </Button>
                    {inspection ? (
                      <Button
                        busy={busy === `tool-trust-${role}`}
                        disabled={!inspection.roleMatches || !inspection.executableByCurrentUser || !toolAcknowledgements[role] || inspection.signature.status === 'invalid'}
                        onClick={() => void trustMediaTool(role)}
                      >
                        <ShieldCheck size={15} /> Trust and probe
                      </Button>
                    ) : null}
                    {state?.configuredPath ? (
                      <Button variant="ghost" busy={busy === `tool-clear-${role}`} onClick={() => void clearMediaTool(role)}>
                        Clear override
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title="Autopilot policy" subtitle="Queue limits prevent runaway projects, spend, and storage">
          <div className="settings-form two-column">
            <NumberField label="Target minutes" value={form.targetVideoMinutes} min={1} max={30} set={value => setForm({ ...form, targetVideoMinutes: value })} />
            <NumberField label="Monthly API budget ($)" value={form.monthlyBudgetUsd} min={0} max={10000} set={value => setForm({ ...form, monthlyBudgetUsd: value })} />
            <NumberField label="Per-project API budget ($)" value={form.projectBudgetUsd} min={0} max={10000} set={value => setForm({ ...form, projectBudgetUsd: value })} />
            <NumberField label="Active projects" value={form.maxActiveProjects} min={1} max={10} set={value => setForm({ ...form, maxActiveProjects: value })} />
            <NumberField label="Waiting downloads" value={form.maxWaitingDownloads} min={1} max={10} set={value => setForm({ ...form, maxWaitingDownloads: value })} />
            <NumberField label="Minimum free disk (GB)" value={form.minFreeDiskGb} min={5} max={1000} set={value => setForm({ ...form, minFreeDiskGb: value })} />
            <NumberField label="Shot hard maximum (sec)" value={form.hardShotMaxSeconds} min={2} max={7} step={0.5} set={value => setForm({ ...form, hardShotMaxSeconds: value })} />
            <NumberField label="Maximum uses per source" value={form.matchingMaxSourceUses} min={1} max={10} set={value => setForm({ ...form, matchingMaxSourceUses: value })} />
            <NumberField label="Maximum repeated shot/motion" value={form.matchingMaxConsecutiveShotMotion} min={1} max={5} set={value => setForm({ ...form, matchingMaxConsecutiveShotMotion: value })} />
            <NumberField label="Perceptual duplicate distance" value={form.matchingPerceptualDistance} min={0} max={16} set={value => setForm({ ...form, matchingPerceptualDistance: value })} />
            <label>
              <span>Hero reservation</span>
              <select value={form.matchingHeroStrategy} onChange={event => setForm({ ...form, matchingHeroStrategy: event.target.value as AppSettings['matchingHeroStrategy'] })}>
                <option value="opening">Opening hook</option>
                <option value="first_major_transition">First major chapter transition</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
            <label>
              <span>Default output</span>
              <select value={form.defaultOutput} onChange={event => setForm({ ...form, defaultOutput: event.target.value as AppSettings['defaultOutput'] })}>
                <option value="1080p">1080p H.264 MP4</option>
                <option value="qualified_4k">4K only when fully qualified</option>
              </select>
            </label>
            <label className="checkbox-field">
              <input type="checkbox" checked={form.autoUploadPrivate} onChange={event => setForm({ ...form, autoUploadPrivate: event.target.checked })} />
              <span>Automatically upload final QC-passed videos as private</span>
            </label>
            <label className="checkbox-field">
              <input type="checkbox" checked={form.autopilotSchedulerEnabled} onChange={event => setForm({ ...form, autopilotSchedulerEnabled: event.target.checked })} />
              <span>Create a new coverage-qualified project on cadence when every gate passes</span>
            </label>
            <NumberField label="Cadence (days)" value={form.autopilotCadenceDays} min={1} max={90} set={value => setForm({ ...form, autopilotCadenceDays: value })} />
            <NumberField label="Publication hour (UTC)" value={form.autopilotPublicationHourUtc} min={0} max={23} set={value => setForm({ ...form, autopilotPublicationHourUtc: value })} />
          </div>
        </Panel>

        <Panel title="Backup policy" subtitle="Verified backups run automatically while the application is open">
          <div className="settings-form two-column">
            <NumberField label="Backup interval (hours)" value={form.backupIntervalHours} min={1} max={168} set={value => setForm({ ...form, backupIntervalHours: value })} />
            <NumberField label="Daily copies" value={form.backupDailyRetention} min={1} max={365} set={value => setForm({ ...form, backupDailyRetention: value })} />
            <NumberField label="Weekly copies" value={form.backupWeeklyRetention} min={1} max={260} set={value => setForm({ ...form, backupWeeklyRetention: value })} />
            <NumberField label="Monthly copies" value={form.backupMonthlyRetention} min={1} max={120} set={value => setForm({ ...form, backupMonthlyRetention: value })} />
          </div>
        </Panel>

        <Panel title="Audio and derivative storage" subtitle="Licensed music stays immutable; only regenerable derivatives are pressure-cleaned">
          <div className="settings-form two-column">
            <label className="checkbox-field">
              <input type="checkbox" checked={form.musicEnabled} onChange={event => setForm({ ...form, musicEnabled: event.target.checked })} />
              <span>Mix license-verified project music with narration ducking</span>
            </label>
            <NumberField label="Music gain (dB)" value={form.musicTargetGainDb} min={-40} max={-12} step={1} set={value => setForm({ ...form, musicTargetGainDb: value })} />
            <NumberField label="Narration ducking (dB)" value={form.musicDuckingDb} min={-30} max={-6} step={1} set={value => setForm({ ...form, musicDuckingDb: value })} />
            <label className="checkbox-field">
              <input type="checkbox" checked={form.automaticDerivativeCleanup} onChange={event => setForm({ ...form, automaticDerivativeCleanup: event.target.checked })} />
              <span>Clean regenerable derivatives under disk pressure</span>
            </label>
            <NumberField label="Cleanup reserve (GB)" value={form.derivativeCleanupTargetGb} min={1} max={1000} set={value => setForm({ ...form, derivativeCleanupTargetGb: value })} />
            <Button variant="secondary" busy={busy === 'storage-cleanup'} onClick={() => void cleanupStorage()}>Clean derivatives now</Button>
            <small>{bootstrap.musicTracks.length} licensed music track(s) · {bootstrap.latestStorageCleanup ? `last cleanup ${bootstrap.latestStorageCleanup.status}` : 'no cleanup receipt yet'}</small>
            <div className="music-import-block">
              <div className="section-label"><Music2 size={14} /> Import licensed music</div>
              <label><span>Track title</span><input value={musicDraft.title} onChange={event => setMusicDraft({ ...musicDraft, title: event.target.value })} /></label>
              <label><span>Provider / library</span><input value={musicDraft.provider} onChange={event => setMusicDraft({ ...musicDraft, provider: event.target.value })} /></label>
              <label><span>License type</span><input value={musicDraft.licenseType} onChange={event => setMusicDraft({ ...musicDraft, licenseType: event.target.value })} /></label>
              <label><span>License receipt or reference</span><input value={musicDraft.licenseReference} onChange={event => setMusicDraft({ ...musicDraft, licenseReference: event.target.value })} /></label>
              <label className="full"><span>License document (optional)</span><div className="path-field"><input readOnly value={musicDraft.licenseDocumentPath} placeholder="No document selected" /><button onClick={() => void chooseMusicLicense()}><Folder size={15} /></button></div></label>
              <label><span>Moods (comma-separated)</span><input value={musicDraft.moods} onChange={event => setMusicDraft({ ...musicDraft, moods: event.target.value })} /></label>
              <label><span>Tempo BPM (optional)</span><input type="number" min="20" max="300" value={musicDraft.tempoBpm} onChange={event => setMusicDraft({ ...musicDraft, tempoBpm: event.target.value })} /></label>
              <label className="checkbox-field"><input type="checkbox" checked={musicDraft.loopable} onChange={event => setMusicDraft({ ...musicDraft, loopable: event.target.checked })} /><span>Track may be looped to fit the final timeline</span></label>
              <label className="checkbox-field license-attestation"><input type="checkbox" checked={musicDraft.licenseAttested} onChange={event => setMusicDraft({ ...musicDraft, licenseAttested: event.target.checked })} /><span>I attest that this track is licensed for the intended project use.</span></label>
              <Button
                variant="secondary"
                busy={busy === 'music-import'}
                disabled={!musicDraft.title.trim() || !musicDraft.provider.trim() || !musicDraft.licenseType.trim() || !musicDraft.licenseReference.trim() || !musicDraft.licenseAttested}
                onClick={() => void importMusic()}
              ><Music2 size={15} /> Choose audio and import</Button>
              {bootstrap.musicTracks.length ? <div className="music-track-list">{bootstrap.musicTracks.map(track => <div key={track.id}><Music2 size={13} /><div><strong>{track.title}</strong><span>{track.provider} · {track.licenseType} · {(track.durationMs / 1000).toFixed(1)} sec</span></div><StatusPill value={track.licenseVerifiedAt ? 'license verified' : 'blocked'} /></div>)}</div> : null}
            </div>
          </div>
        </Panel>

        <Panel title="Catalog refresh" subtitle="Scheduled refreshes stage a validated diff and never commit silently">
          <div className="settings-form">
            <label>
              <span>Catalog XLSX/CSV source</span>
              <div className="path-field">
                <input value={form.catalogImportFile} readOnly />
                <button onClick={() => void choose('catalogImportFile')}><Folder size={15} /></button>
              </div>
            </label>
            <NumberField label="Refresh interval (hours)" value={form.catalogRefreshIntervalHours} min={1} max={720} set={value => setForm({ ...form, catalogRefreshIntervalHours: value })} />
            <label>
              <span>Validation template</span>
              <select value={form.catalogValidationTemplateId} onChange={event => setForm({ ...form, catalogValidationTemplateId: event.target.value })}>
                <option value="envato-default">Envato catalog</option>
                <option value="strict-grounding">Strict geographic grounding</option>
                <option value="technical-library">Technical media library</option>
              </select>
            </label>
            <label className="checkbox-field">
              <input type="checkbox" checked={form.catalogRefreshEnabled} onChange={event => setForm({ ...form, catalogRefreshEnabled: event.target.checked })} />
              <span>Stage catalog refreshes on schedule</span>
            </label>
            <Button variant="secondary" busy={busy === 'catalog-refresh'} onClick={() => void refreshCatalog()}><RefreshCw size={15} /> Stage refresh now</Button>
            {bootstrap.latestCatalogRefresh ? <small>Last refresh: {bootstrap.latestCatalogRefresh.status} · {new Date(bootstrap.latestCatalogRefresh.createdAt).toLocaleString()}</small> : null}
          </div>
        </Panel>

        <Panel title="Channels, languages, and outputs" subtitle="Profiles are snapshotted into new projects; live multi-channel publishing and additional voices remain unverified">
          <div className="settings-form expansion-registry">
            <div className="section-label"><Network size={14} /> Channel registry</div>
            <div className="registry-list">
              {bootstrap.expansion.channels.map(channel => <div key={channel.id}><div><strong>{channel.name}</strong><span>{channel.shortCode} · {channel.defaultLanguageCode}</span></div><StatusPill value={channel.isDefault ? 'default' : channel.externalQualification} /></div>)}
            </div>
            <div className="registry-draft">
              <label><span>Name</span><input value={channelDraft.name} onChange={event => setChannelDraft({ ...channelDraft, name: event.target.value })} /></label>
              <label><span>Short code</span><input maxLength={12} value={channelDraft.shortCode} onChange={event => setChannelDraft({ ...channelDraft, shortCode: event.target.value.toUpperCase() })} /></label>
              <label><span>Default language</span><input value={channelDraft.defaultLanguageCode} onChange={event => setChannelDraft({ ...channelDraft, defaultLanguageCode: event.target.value })} /></label>
              <Button variant="secondary" busy={busy === 'channel-add'} disabled={!channelDraft.name || !channelDraft.shortCode} onClick={() => void addChannel()}>Add channel profile</Button>
            </div>
            <div className="section-label"><Languages size={14} /> Language and voice registry</div>
            <div className="registry-list">
              {bootstrap.expansion.languages.map(language => <div key={language.id}><div><strong>{language.displayName}</strong><span>{language.languageCode} · {language.voiceProvider} · {language.voiceId}</span></div><StatusPill value={language.isDefault ? 'default' : language.externalQualification} /></div>)}
            </div>
            <div className="registry-draft">
              <label><span>Language code</span><input value={languageDraft.languageCode} onChange={event => setLanguageDraft({ ...languageDraft, languageCode: event.target.value })} /></label>
              <label><span>Language name</span><input value={languageDraft.languageName} onChange={event => setLanguageDraft({ ...languageDraft, languageName: event.target.value })} /></label>
              <label><span>Voice provider</span><input value={languageDraft.voiceProvider} onChange={event => setLanguageDraft({ ...languageDraft, voiceProvider: event.target.value })} /></label>
              <label><span>Voice ID</span><input value={languageDraft.voiceId} onChange={event => setLanguageDraft({ ...languageDraft, voiceId: event.target.value })} /></label>
              <label><span>Display name</span><input value={languageDraft.displayName} onChange={event => setLanguageDraft({ ...languageDraft, displayName: event.target.value })} /></label>
              <Button variant="secondary" busy={busy === 'language-add'} disabled={!languageDraft.languageCode || !languageDraft.languageName || !languageDraft.voiceId || !languageDraft.displayName} onClick={() => void addLanguage()}>Add voice profile</Button>
            </div>
            <div className="section-label">Output profiles</div>
            <div className="registry-list">
              {bootstrap.expansion.outputProfiles.map(profile => <div key={profile.id}><div><strong>{profile.displayName}</strong><span>{profile.width}×{profile.height} · {profile.orientation} · {profile.frameRate} fps</span></div><StatusPill value={profile.isDefault ? 'default' : 'available'} /></div>)}
            </div>
          </div>
        </Panel>

        <Panel title="Read-only Google Sheets sync" subtitle="Uses OAuth read scope, materializes a bounded workbook, and only stages the existing catalog diff">
          <div className="settings-form">
            <label><span>Spreadsheet ID</span><input value={sheetDraft.spreadsheetId} onChange={event => setSheetDraft({ ...sheetDraft, spreadsheetId: event.target.value })} /></label>
            <label><span>Sheet range</span><input value={sheetDraft.sheetRange} onChange={event => setSheetDraft({ ...sheetDraft, sheetRange: event.target.value })} /></label>
            <div className="button-row">
              <Button variant="secondary" busy={busy === 'sheets-sync'} disabled={!sheetDraft.spreadsheetId || !sheetDraft.sheetRange || !bootstrap.secrets.youtubeAuthorized} onClick={() => void stageGoogleSheet()}><Sheet size={15} /> Fetch and stage diff</Button>
              {sheetOperationId ? <Button variant="danger" busy={sheetCancellationRequested} onClick={() => void cancelGoogleSheet()}><X size={15} /> {sheetCancellationRequested ? 'Cancelling safely' : 'Cancel staging'}</Button> : null}
            </div>
            <small>{bootstrap.secrets.youtubeAuthorized ? 'Google OAuth is configured. Live Sheets access remains unqualified until a real rehearsal succeeds.' : 'Connect Google OAuth first. The app requests read-only Sheets access and never writes to the spreadsheet.'}</small>
          </div>
        </Panel>

        <Panel title="Provider capability registry" subtitle="Configured and available are runtime facts; external qualification remains a separate evidence gate">
          <div className="provider-registry">
            {bootstrap.expansion.providers.map(provider => (
              <div key={provider.id}>
                <div><strong>{provider.displayName}</strong><span>{provider.capability.replaceAll('_', ' ')} · {provider.implementation}</span><small>{provider.statusMessage ?? 'No runtime receipt.'}</small></div>
                <div><StatusPill value={provider.configured ? 'configured' : 'not configured'} /><StatusPill value={provider.available ? 'available' : 'unavailable'} /><StatusPill value={provider.externalQualification} /></div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Settings profile and updates" subtitle="Profiles are portable and secret-free; update checks never install code">
          <div className="settings-form">
            <label>
              <span>Update channel</span>
              <select value={form.updateChannel} onChange={event => setForm({ ...form, updateChannel: event.target.value as AppSettings['updateChannel'] })}>
                <option value="stable">Stable releases</option>
                <option value="prerelease">Prereleases</option>
              </select>
            </label>
            <label className="checkbox-field">
              <input type="checkbox" checked={form.updateCheckEnabled} onChange={event => setForm({ ...form, updateCheckEnabled: event.target.checked })} />
              <span>Check GitHub daily for new releases</span>
            </label>
            <div className="button-row">
              <Button variant="secondary" busy={busy === 'profile-export'} onClick={() => void exportProfile()}><Download size={15} /> Export profile</Button>
              <Button variant="ghost" busy={busy === 'profile-import'} onClick={() => void importProfile()}><Upload size={15} /> Import profile</Button>
              <Button variant="ghost" busy={busy === 'update'} onClick={() => void checkUpdate()}><RefreshCw size={15} /> Check updates</Button>
            </div>
            {bootstrap.latestUpdateCheck ? <div className="diagnostic-list"><div><RefreshCw size={14} /><div><strong>{bootstrap.latestUpdateCheck.available ? `${bootstrap.latestUpdateCheck.latestVersion} available` : bootstrap.latestUpdateCheck.status}</strong><span>{bootstrap.latestUpdateCheck.error ?? `Checked ${new Date(bootstrap.latestUpdateCheck.checkedAt).toLocaleString()}`}</span></div>{bootstrap.latestUpdateCheck.releaseUrl ? <button className="text-link" onClick={() => void window.videoFactory.system.openExternal(bootstrap.latestUpdateCheck!.releaseUrl!)}>Open release</button> : null}</div></div> : null}
          </div>
        </Panel>

        <Panel title="Script intelligence" subtitle="A generic OpenAI-compatible endpoint is optional; local fallback creates descriptive provisional scripts">
          <div className="settings-form">
            <label>
              <span>Provider</span>
              <select value={form.llmProvider} onChange={event => setForm({ ...form, llmProvider: event.target.value as AppSettings['llmProvider'] })}>
                <option value="mock">Local metadata-only fallback</option>
                <option value="openai_compatible">OpenAI-compatible HTTP API</option>
              </select>
            </label>
            <label>
              <span>Endpoint trust</span>
              <select value={form.llmEndpointTrust} onChange={event => {
                const trust = event.target.value as ProviderEndpointTrustMode;
                setForm({ ...form, llmEndpointTrust: trust, llmBaseUrl: trust === 'managed' ? 'https://api.openai.com/v1' : form.llmBaseUrl });
              }}>
                <option value="managed">Managed OpenAI origin</option>
                <option value="custom_remote">Confirmed custom HTTPS origin</option>
                <option value="custom_local">Local loopback · no API key</option>
              </select>
            </label>
            <label><span>Base URL</span><input value={form.llmBaseUrl} onChange={event => setForm({ ...form, llmBaseUrl: event.target.value })} /></label>
            <label><span>Model</span><input value={form.llmModel} onChange={event => setForm({ ...form, llmModel: event.target.value })} /></label>
            <label><span>API key {bootstrap.secrets.llmApiKeyConfigured ? '· configured' : ''}</span><input type="password" value={secrets.llmApiKey} onChange={event => setSecrets({ ...secrets, llmApiKey: event.target.value })} placeholder={bootstrap.secrets.llmApiKeyConfigured ? 'Leave blank to keep current key' : 'Required for configured provider'} /></label>
            <ProviderEndpointControls
              state={endpoint('openai_compatible')}
              busy={busy}
              hasUnsavedChanges={form.llmBaseUrl !== bootstrap.settings.llmBaseUrl || form.llmEndpointTrust !== bootstrap.settings.llmEndpointTrust}
              credentialConfigured={bootstrap.secrets.llmApiKeyConfigured}
              onTrust={trustProviderEndpoint}
              onClear={clearProviderEndpointTrust}
              onRemoveCredential={() => removeProviderCredential('openai_compatible', 'llmApiKey')}
            />
          </div>
        </Panel>

        <Panel title="Narration" subtitle="Section voice is cached by final text, voice, model, settings, and pronunciation dictionary">
          <div className="settings-form">
            <label>
              <span>Provider</span>
              <select value={form.narratorProvider} onChange={event => setForm({ ...form, narratorProvider: event.target.value as AppSettings['narratorProvider'] })}>
                <option value="windows_sapi">Windows SAPI</option>
                <option value="http_tts">Generic HTTP TTS</option>
              </select>
            </label>
            <label>
              <span>Endpoint trust</span>
              <select value={form.narratorEndpointTrust} onChange={event => setForm({ ...form, narratorEndpointTrust: event.target.value as ProviderEndpointTrustMode })}>
                <option value="custom_remote">Confirmed custom HTTPS origin</option>
                <option value="custom_local">Local loopback · no API key</option>
              </select>
            </label>
            <label><span>HTTP base URL</span><input value={form.narratorBaseUrl} onChange={event => setForm({ ...form, narratorBaseUrl: event.target.value })} /></label>
            <label><span>Model</span><input value={form.narratorModel} onChange={event => setForm({ ...form, narratorModel: event.target.value })} /></label>
            <label><span>Voice name</span><input value={form.narratorVoice} onChange={event => setForm({ ...form, narratorVoice: event.target.value })} placeholder="Blank uses Windows default" /></label>
            <NumberField label="Voice rate" value={form.narratorRate} min={-10} max={10} set={value => setForm({ ...form, narratorRate: value })} />
            <label><span>HTTP API key {bootstrap.secrets.httpTtsApiKeyConfigured ? '· configured' : ''}</span><input type="password" value={secrets.httpTtsApiKey} onChange={event => setSecrets({ ...secrets, httpTtsApiKey: event.target.value })} placeholder={bootstrap.secrets.httpTtsApiKeyConfigured ? 'Leave blank to keep current key' : 'Required when HTTP TTS is enabled'} /></label>
            <ProviderEndpointControls
              state={endpoint('http_tts')}
              busy={busy}
              hasUnsavedChanges={form.narratorBaseUrl !== bootstrap.settings.narratorBaseUrl || form.narratorEndpointTrust !== bootstrap.settings.narratorEndpointTrust}
              credentialConfigured={bootstrap.secrets.httpTtsApiKeyConfigured}
              onTrust={trustProviderEndpoint}
              onClear={clearProviderEndpointTrust}
              onRemoveCredential={() => removeProviderCredential('http_tts', 'httpTtsApiKey')}
            />
            <label>
              <span>Pronunciation dictionary (one term = spoken form per line)</span>
              <textarea
                rows={6}
                value={Object.entries(form.pronunciationDictionary).map(([term, pronunciation]) => `${term} = ${pronunciation}`).join('\n')}
                onChange={event => setForm({
                  ...form,
                  pronunciationDictionary: Object.fromEntries(
                    event.target.value.split(/\r?\n/).map(line => line.split('=').map(value => value.trim())).filter(parts => parts.length >= 2 && parts[0] && parts.slice(1).join('=').trim()).map(parts => [parts[0]!, parts.slice(1).join('=').trim()])
                  )
                })}
                placeholder={'Oaxaca = wah-HAH-kah\nChichén Itzá = chee-CHEN eet-SAH'}
              />
            </label>
          </div>
        </Panel>

        <Panel title="Web research" subtitle="Accepted material facts retain real URLs and are omitted when stale or conflicting">
          <div className="settings-form">
            <label>
              <span>Provider</span>
              <select value={form.researchProvider} onChange={event => setForm({ ...form, researchProvider: event.target.value as AppSettings['researchProvider'] })}>
                <option value="disabled">Disabled — visual observations only</option>
                <option value="tavily">Tavily Search + Extract</option>
              </select>
            </label>
            <label>
              <span>Endpoint trust</span>
              <select value={form.researchEndpointTrust} onChange={event => {
                const trust = event.target.value as ProviderEndpointTrustMode;
                setForm({ ...form, researchEndpointTrust: trust, researchBaseUrl: trust === 'managed' ? 'https://api.tavily.com' : form.researchBaseUrl });
              }}>
                <option value="managed">Managed Tavily origin</option>
                <option value="custom_remote">Confirmed custom HTTPS origin</option>
                <option value="custom_local">Local loopback · no API key</option>
              </select>
            </label>
            <label><span>Base URL</span><input value={form.researchBaseUrl} onChange={event => setForm({ ...form, researchBaseUrl: event.target.value })} /></label>
            <label>
              <span>Search depth</span>
              <select value={form.researchSearchDepth} onChange={event => setForm({ ...form, researchSearchDepth: event.target.value as AppSettings['researchSearchDepth'] })}>
                <option value="basic">Basic</option>
                <option value="advanced">Advanced</option>
              </select>
            </label>
            <NumberField label="Results per query" value={form.researchMaxResultsPerQuery} min={1} max={5} set={value => setForm({ ...form, researchMaxResultsPerQuery: value })} />
            <label><span>Research API key {bootstrap.secrets.researchApiKeyConfigured ? '· configured' : ''}</span><input type="password" value={secrets.researchApiKey} onChange={event => setSecrets({ ...secrets, researchApiKey: event.target.value })} placeholder={bootstrap.secrets.researchApiKeyConfigured ? 'Leave blank to keep current key' : 'Required when Tavily is enabled'} /></label>
            <ProviderEndpointControls
              state={endpoint('tavily')}
              busy={busy}
              hasUnsavedChanges={form.researchBaseUrl !== bootstrap.settings.researchBaseUrl || form.researchEndpointTrust !== bootstrap.settings.researchEndpointTrust}
              credentialConfigured={bootstrap.secrets.researchApiKeyConfigured}
              onTrust={trustProviderEndpoint}
              onClear={clearProviderEndpointTrust}
              onRemoveCredential={() => removeProviderCredential('tavily', 'researchApiKey')}
            />
          </div>
        </Panel>

        <Panel title="Footage verification" subtitle="Semantic verification is fail-closed; only bounded contact sheets are sent to the configured provider">
          <div className="settings-form">
            <label>
              <span>Provider</span>
              <select value={form.visionProvider} onChange={event => setForm({ ...form, visionProvider: event.target.value as AppSettings['visionProvider'] })}>
                <option value="disabled">Disabled — require human-verified evidence</option>
                <option value="openai_compatible">OpenAI-compatible multimodal API</option>
              </select>
            </label>
            <label>
              <span>Endpoint trust</span>
              <select value={form.visionEndpointTrust} onChange={event => {
                const trust = event.target.value as ProviderEndpointTrustMode;
                setForm({ ...form, visionEndpointTrust: trust, visionBaseUrl: trust === 'managed' ? 'https://api.openai.com/v1' : form.visionBaseUrl });
              }}>
                <option value="managed">Managed OpenAI origin</option>
                <option value="custom_remote">Confirmed custom HTTPS origin</option>
                <option value="custom_local">Local loopback · no API key</option>
              </select>
            </label>
            <label><span>Base URL</span><input value={form.visionBaseUrl} onChange={event => setForm({ ...form, visionBaseUrl: event.target.value })} /></label>
            <label><span>Vision model</span><input value={form.visionModel} onChange={event => setForm({ ...form, visionModel: event.target.value })} /></label>
            <NumberField label="Minimum confidence" value={form.visionMinimumConfidence} min={0.5} max={0.99} step={0.01} set={value => setForm({ ...form, visionMinimumConfidence: value })} />
            <label><span>Vision API key {bootstrap.secrets.visionApiKeyConfigured ? '· configured' : ''}</span><input type="password" value={secrets.visionApiKey} onChange={event => setSecrets({ ...secrets, visionApiKey: event.target.value })} placeholder={bootstrap.secrets.visionApiKeyConfigured ? 'Leave blank to keep current key' : 'Required for semantic verification'} /></label>
            <ProviderEndpointControls
              state={endpoint('openai_compatible_vision')}
              busy={busy}
              hasUnsavedChanges={form.visionBaseUrl !== bootstrap.settings.visionBaseUrl || form.visionEndpointTrust !== bootstrap.settings.visionEndpointTrust}
              credentialConfigured={bootstrap.secrets.visionApiKeyConfigured}
              onTrust={trustProviderEndpoint}
              onClear={clearProviderEndpointTrust}
              onRemoveCredential={() => removeProviderCredential('openai_compatible_vision', 'visionApiKey')}
            />
          </div>
        </Panel>

        <Panel title="YouTube connection" subtitle="OAuth tokens are encrypted with the operating system; uploads begin private">
          <div className="settings-form">
            <label><span>Channel display name</span><input value={form.channelName} onChange={event => setForm({ ...form, channelName: event.target.value })} /></label>
            <label><span>Project short code</span><input value={form.channelShort} onChange={event => setForm({ ...form, channelShort: event.target.value.toUpperCase() })} maxLength={12} /></label>
            <label><span>OAuth client ID {bootstrap.secrets.youtubeClientConfigured ? '· configured' : ''}</span><input type="password" value={secrets.youtubeClientId} onChange={event => setSecrets({ ...secrets, youtubeClientId: event.target.value })} /></label>
            <label><span>OAuth client secret</span><input type="password" value={secrets.youtubeClientSecret} onChange={event => setSecrets({ ...secrets, youtubeClientSecret: event.target.value })} /></label>
            <label><span>YouTube API key {bootstrap.secrets.youtubeApiKeyConfigured ? '· configured' : ''}</span><input type="password" value={secrets.youtubeApiKey} onChange={event => setSecrets({ ...secrets, youtubeApiKey: event.target.value })} /></label>
            <label><span>Playlist ID (optional)</span><input value={form.youtubePlaylistId} onChange={event => setForm({ ...form, youtubePlaylistId: event.target.value })} /></label>
            <label className="checkbox-field">
              <input type="checkbox" checked={form.youtubeSyntheticMediaDisclosure} onChange={event => setForm({ ...form, youtubeSyntheticMediaDisclosure: event.target.checked })} />
              <span>Disclose synthetic media (enabled by default for generated narration)</span>
            </label>
            <div className="button-row">
              <Button variant="secondary" busy={busy === 'youtube'} onClick={() => void connectYouTube()}>
                <Youtube size={16} /> {youtube?.authorized ? 'Reconnect or replace channel' : 'Connect YouTube'}
              </Button>
              {youtube ? <StatusPill value={youtube.state.replaceAll('_', ' ')} /> : null}
            </div>
            {youtube?.authorized ? (
              <small>
                Confirmed destination: <strong>{youtube.channelTitle}</strong> ({youtube.channelId}).
                Every automatic upload and publication is locked to this channel.
              </small>
            ) : null}
            {youtube?.pendingAuthorization ? (
              <div className="diagnostic-list">
                <div>
                  <ShieldCheck size={14} />
                  <div>
                    <strong>{youtube.pendingAuthorization.phase === 'confirmation_required'
                      ? 'Verify the exact destination channel'
                      : 'Waiting for Google authorization'}</strong>
                    <span>{youtube.pendingAuthorization.phase === 'confirmation_required'
                      ? `${youtube.pendingAuthorization.channelTitle} (${youtube.pendingAuthorization.channelId})`
                      : 'Complete the browser flow, then return here. No token is saved before confirmation.'}</span>
                  </div>
                </div>
                {youtube.pendingAuthorization.replacement ? (
                  <div>
                    <ShieldCheck size={14} />
                    <div>
                      <strong>Channel replacement</strong>
                      <span>
                        Existing: {youtube.pendingAuthorization.previousChannelTitle} ({youtube.pendingAuthorization.previousChannelId})
                        {' → '}New: {youtube.pendingAuthorization.channelTitle} ({youtube.pendingAuthorization.channelId})
                      </span>
                    </div>
                  </div>
                ) : null}
                <div className="button-row">
                  {youtube.pendingAuthorization.phase === 'confirmation_required' ? (
                    <Button busy={busy === 'youtube-confirm'} onClick={() => void confirmYouTube()}>
                      <Check size={15} /> {youtube.pendingAuthorization.replacement ? 'Confirm channel replacement' : 'Confirm this channel'}
                    </Button>
                  ) : null}
                  <Button variant="ghost" busy={busy === 'youtube-cancel'} onClick={() => void cancelYouTube()}>
                    <X size={15} /> Cancel authorization
                  </Button>
                </div>
              </div>
            ) : null}
            {youtube?.error ? <small>{youtube.error.message}</small> : null}
          </div>
        </Panel>

        <Panel title="System diagnostics" subtitle="Executable, storage, database, and encoder health">
          <div className="diagnostic-list">
            {(diagnostics?.paths ?? []).map(path => (
              <div key={path.key}>
                <Check size={14} className={path.exists && path.writable ? 'good-icon' : 'bad-icon'} />
                <div><strong>{path.key}</strong><span>{path.path}</span></div>
                <StatusPill value={path.exists && path.writable ? 'ready' : 'check path'} />
              </div>
            ))}
            <div>
              <Cpu size={14} />
              <div><strong>H.264 encoders</strong><span>{diagnostics ? (diagnostics.ffmpeg.encoders.join(', ') || 'No encoder detected') : 'Checking encoder availability…'}</span></div>
            </div>
          </div>
          <Button
            variant="ghost"
            busy={busy === 'diagnostics'}
            onClick={() => void run('diagnostics', async () => setDiagnostics(await window.videoFactory.diagnostics.run()))}
          >
            <RefreshCw size={15} /> Run diagnostics
          </Button>
          <div className="button-row">
            <Button variant="secondary" busy={busy === 'backup'} onClick={() => void createBackup()}>
              <DatabaseBackup size={15} /> Create verified backup
            </Button>
            <Button variant="ghost" busy={busy === 'restore'} onClick={() => void restoreBackup()}>
              Restore backup
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function ProviderEndpointControls({
  state,
  busy,
  hasUnsavedChanges,
  credentialConfigured,
  onTrust,
  onClear,
  onRemoveCredential
}: {
  state: ProviderEndpointState | undefined;
  busy: string;
  hasUnsavedChanges: boolean;
  credentialConfigured: boolean;
  onTrust: (provider: ProviderEndpointId) => Promise<void>;
  onClear: (provider: ProviderEndpointId) => Promise<void>;
  onRemoveCredential: () => Promise<void>;
}) {
  if (!state) return null;
  return (
    <div className="diagnostic-list">
      <div>
        <Network size={14} />
        <div>
          <strong>{state.canonicalOrigin ?? 'Invalid endpoint'}</strong>
          <span>{hasUnsavedChanges ? 'Save endpoint and trust-mode changes before confirming them.' : state.message} Status reflects the last saved settings.</span>
        </div>
        <StatusPill value={hasUnsavedChanges ? 'unsaved changes' : state.active ? state.status.replaceAll('_', ' ') : 'inactive'} />
      </div>
      <div>
        <ShieldCheck size={14} />
        <div>
          <strong>{state.trustMode.replaceAll('_', ' ')}</strong>
          <span>Sends: {state.dataCategories.join(', ')}.</span>
        </div>
        <StatusPill value={state.credentialBound ? 'credential bound' : 'blocked'} />
      </div>
      <div className="button-row">
        {state.trustMode !== 'managed' && state.status !== 'invalid_endpoint' ? (
          <Button
            variant="secondary"
            busy={busy === `endpoint-trust-${state.provider}`}
            disabled={hasUnsavedChanges}
            onClick={() => void onTrust(state.provider)}
          >
            <ShieldCheck size={15} /> {state.status === 'confirmed' ? 'Reconfirm endpoint' : 'Confirm endpoint'}
          </Button>
        ) : null}
        {state.trustMode !== 'managed' && state.status === 'confirmed' ? (
          <Button
            variant="ghost"
            busy={busy === `endpoint-clear-${state.provider}`}
            disabled={hasUnsavedChanges}
            onClick={() => void onClear(state.provider)}
          >
            Clear confirmation
          </Button>
        ) : null}
        {credentialConfigured ? (
          <Button
            variant="ghost"
            busy={busy === `endpoint-key-${state.provider}`}
            onClick={() => void onRemoveCredential()}
          >
            <KeyRound size={15} /> Remove stored key
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function PathField({
  label,
  field,
  value,
  choose
}: {
  label: string;
  field: keyof AppSettings;
  value: string;
  choose: (field: keyof AppSettings) => Promise<void>;
}) {
  return (
    <label>
      <span>{label}</span>
      <div className="path-field">
        <input value={value} readOnly />
        <button onClick={() => void choose(field)}><Folder size={15} /></button>
      </div>
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  set
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  set: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input type="number" value={value} min={min} max={max} step={step} onChange={event => set(Number(event.target.value))} />
    </label>
  );
}
