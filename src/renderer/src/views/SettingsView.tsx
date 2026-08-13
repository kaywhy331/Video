import { useEffect, useState } from 'react';
import {
  Check,
  Cpu,
  Folder,
  HardDrive,
  KeyRound,
  RefreshCw,
  Save,
  ShieldCheck,
  DatabaseBackup,
  Youtube
} from 'lucide-react';
import type { AppBootstrap, AppSettings, DiagnosticsReport, YouTubeConnectionStatus } from '@shared/types';
import { Button, MetricCard, Panel, StatusPill } from '../components/ui';

export function SettingsView({
  bootstrap,
  onRefresh,
  setError
}: {
  bootstrap: AppBootstrap;
  onRefresh: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [form, setForm] = useState<AppSettings>(bootstrap.settings);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport>(bootstrap.diagnostics);
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

  useEffect(() => {
    void window.videoFactory.youtube.status().then(setYoutube).catch(() => undefined);
  }, []);

  async function choose(field: keyof AppSettings): Promise<void> {
    const path = await window.videoFactory.settings.choosePath({
      kind: field.toLowerCase().includes('path') && (field === 'ffmpegPath' || field === 'ffprobePath') ? 'file' : 'directory',
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
      if (Object.keys(secretPatch).length) {
        await window.videoFactory.settings.updateSecrets(secretPatch);
        setSecrets({ llmApiKey: '', visionApiKey: '', researchApiKey: '', httpTtsApiKey: '', youtubeClientId: '', youtubeClientSecret: '', youtubeApiKey: '' });
      }
      const next = await window.videoFactory.settings.update(form);
      setForm(next);
      setDiagnostics(await window.videoFactory.diagnostics.run());
      await onRefresh();
    });
  }

  async function connectYouTube(): Promise<void> {
    await run('youtube', async () => {
      setYoutube(await window.videoFactory.youtube.authorize());
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

  const freePath = diagnostics.paths.find(path => path.key === 'Media library');
  const freeGb = freePath?.freeBytes ? Math.round(freePath.freeBytes / 1024 ** 3) : null;

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
        <MetricCard label="FFmpeg" value={diagnostics.ffmpeg.found ? 'Ready' : 'Missing'} detail={diagnostics.ffmpeg.version ?? diagnostics.ffmpeg.error} icon={<Cpu size={18} />} />
        <MetricCard label="Database" value={diagnostics.database.integrity === 'ok' ? 'Healthy' : diagnostics.database.integrity} detail={diagnostics.database.walMode ? 'WAL enabled' : 'WAL disabled'} icon={<HardDrive size={18} />} />
        <MetricCard label="Free media storage" value={freeGb === null ? 'Unknown' : `${freeGb} GB`} detail={`Minimum ${form.minFreeDiskGb} GB`} icon={<HardDrive size={18} />} />
        <MetricCard label="YouTube" value={youtube?.authorized ? 'Connected' : 'Not connected'} detail={youtube?.channelTitle ?? 'Private-first upload'} icon={<Youtube size={18} />} />
      </div>

      <div className="settings-grid">
        <Panel title="Storage paths" subtitle="Database stays local; originals may live on a large local drive or NAS">
          <div className="settings-form">
            <PathField label="Data root" field="dataRoot" value={form.dataRoot} choose={choose} />
            <PathField label="Watched Envato folder" field="ingestFolder" value={form.ingestFolder} choose={choose} />
            <PathField label="Central media library" field="mediaLibraryFolder" value={form.mediaLibraryFolder} choose={choose} />
            <PathField label="Project records" field="projectFolder" value={form.projectFolder} choose={choose} />
            <PathField label="Rendered output" field="outputFolder" value={form.outputFolder} choose={choose} />
            <PathField label="Backups" field="backupFolder" value={form.backupFolder} choose={choose} />
            <PathField label="FFmpeg override" field="ffmpegPath" value={form.ffmpegPath} choose={choose} />
            <PathField label="FFprobe override" field="ffprobePath" value={form.ffprobePath} choose={choose} />
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

        <Panel title="Script intelligence" subtitle="A generic OpenAI-compatible endpoint is optional; local fallback creates descriptive provisional scripts">
          <div className="settings-form">
            <label>
              <span>Provider</span>
              <select value={form.llmProvider} onChange={event => setForm({ ...form, llmProvider: event.target.value as AppSettings['llmProvider'] })}>
                <option value="mock">Local metadata-only fallback</option>
                <option value="openai_compatible">OpenAI-compatible HTTP API</option>
              </select>
            </label>
            <label><span>Base URL</span><input value={form.llmBaseUrl} onChange={event => setForm({ ...form, llmBaseUrl: event.target.value })} /></label>
            <label><span>Model</span><input value={form.llmModel} onChange={event => setForm({ ...form, llmModel: event.target.value })} /></label>
            <label><span>API key {bootstrap.secrets.llmApiKeyConfigured ? '· configured' : ''}</span><input type="password" value={secrets.llmApiKey} onChange={event => setSecrets({ ...secrets, llmApiKey: event.target.value })} placeholder={bootstrap.secrets.llmApiKeyConfigured ? 'Leave blank to keep current key' : 'Required for configured provider'} /></label>
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
            <label><span>HTTP base URL</span><input value={form.narratorBaseUrl} onChange={event => setForm({ ...form, narratorBaseUrl: event.target.value })} /></label>
            <label><span>Model</span><input value={form.narratorModel} onChange={event => setForm({ ...form, narratorModel: event.target.value })} /></label>
            <label><span>Voice name</span><input value={form.narratorVoice} onChange={event => setForm({ ...form, narratorVoice: event.target.value })} placeholder="Blank uses Windows default" /></label>
            <NumberField label="Voice rate" value={form.narratorRate} min={-10} max={10} set={value => setForm({ ...form, narratorRate: value })} />
            <label><span>HTTP API key {bootstrap.secrets.httpTtsApiKeyConfigured ? '· configured' : ''}</span><input type="password" value={secrets.httpTtsApiKey} onChange={event => setSecrets({ ...secrets, httpTtsApiKey: event.target.value })} placeholder={bootstrap.secrets.httpTtsApiKeyConfigured ? 'Leave blank to keep current key' : 'Required when HTTP TTS is enabled'} /></label>
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
            <label><span>Base URL</span><input value={form.visionBaseUrl} onChange={event => setForm({ ...form, visionBaseUrl: event.target.value })} /></label>
            <label><span>Vision model</span><input value={form.visionModel} onChange={event => setForm({ ...form, visionModel: event.target.value })} /></label>
            <NumberField label="Minimum confidence" value={form.visionMinimumConfidence} min={0.5} max={0.99} step={0.01} set={value => setForm({ ...form, visionMinimumConfidence: value })} />
            <label><span>Vision API key {bootstrap.secrets.visionApiKeyConfigured ? '· configured' : ''}</span><input type="password" value={secrets.visionApiKey} onChange={event => setSecrets({ ...secrets, visionApiKey: event.target.value })} placeholder={bootstrap.secrets.visionApiKeyConfigured ? 'Leave blank to keep current key' : 'Required for semantic verification'} /></label>
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
              <Button variant="secondary" busy={busy === 'youtube'} onClick={() => void connectYouTube()}><Youtube size={16} /> Connect YouTube</Button>
              {youtube ? <StatusPill value={youtube.authorized ? 'authorized' : youtube.configured ? 'configured' : 'not configured'} /> : null}
            </div>
          </div>
        </Panel>

        <Panel title="System diagnostics" subtitle="Executable, storage, database, and encoder health">
          <div className="diagnostic-list">
            {diagnostics.paths.map(path => (
              <div key={path.key}>
                <Check size={14} className={path.exists && path.writable ? 'good-icon' : 'bad-icon'} />
                <div><strong>{path.key}</strong><span>{path.path}</span></div>
                <StatusPill value={path.exists && path.writable ? 'ready' : 'check path'} />
              </div>
            ))}
            <div>
              <Cpu size={14} />
              <div><strong>H.264 encoders</strong><span>{diagnostics.ffmpeg.encoders.join(', ') || 'No encoder detected'}</span></div>
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
