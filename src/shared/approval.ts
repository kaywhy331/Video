import { createHash } from 'node:crypto';

export interface ApprovalFingerprintInput {
  finalSha256: string;
  packageId: string;
  title: string;
  description: string;
  chapters: string;
  tags: string[];
  thumbnailSha256: string | null;
}
export function approvalFingerprint(input: ApprovalFingerprintInput): string {
  return createHash('sha256').update(JSON.stringify({
    finalSha256: input.finalSha256,
    packageId: input.packageId,
    title: input.title.trim(),
    description: input.description.trim(),
    chapters: input.chapters.trim(),
    tags: [...input.tags].map(tag => tag.trim()).filter(Boolean),
    thumbnailSha256: input.thumbnailSha256
  })).digest('hex');
}
