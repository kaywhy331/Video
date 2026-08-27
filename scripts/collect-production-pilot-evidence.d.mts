import type { ValidationSource } from './validation-source.mjs';
import type {
  ProductionPilotEvidence,
  ProductionPilotEvidenceInput,
  ProductionPilotMode
} from './production-pilot-evidence.mjs';

export interface ProductionPilotProbe {
  durationMs: number;
  width: number;
  height: number;
  frameRate: number;
  videoCodec: string;
  audioCodec: string;
}

export interface ProductionPilotCollectionOptions {
  root?: string;
  databasePath: string;
  projectIds: string[];
  mode?: ProductionPilotMode;
  deviceClass?: string | null;
  source: ValidationSource;
  appVersion: string;
  now?: Date | string;
  environment?: {
    platform: string;
    release: string;
    architecture: string;
    node: string;
    ci: boolean;
    deviceClass?: string | null;
  };
  probeMedia: (path: string) => Promise<ProductionPilotProbe> | ProductionPilotProbe;
}

export function collectProductionPilotEvidence(options: ProductionPilotCollectionOptions): Promise<{
  receipt: ProductionPilotEvidenceInput;
  assessment: ProductionPilotEvidence;
  root: string;
  databasePath: string;
}>;

export function listProductionPilotCandidates(databasePath: string): Array<{
  id: string;
  title: string;
  destination: string | null;
  state: string;
  updatedAt: string;
  finalDurationMs: number | null;
  processingStatus: string | null;
  scheduledAt: string | null;
  approvedAt: string | null;
}>;

export function probeMediaWithFfprobe(mediaPath: string, ffprobePath: string): ProductionPilotProbe;
