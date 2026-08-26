import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import {
  PrivilegedOperationError,
  recordSecurityRejection,
  rejectPrivilegedOperation
} from '@main/security-events';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('privileged security rejection contract', () => {
  it('[SEC-013] records a stable, redacted, structured event with actionable recovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-security-event-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'db.sqlite'));
    const recovery = 'Reconnect YouTube and confirm the exact destination channel.';
    recordSecurityRejection(db, {
      flow: 'oauth',
      operation: 'callback.state_validation',
      code: 'OAUTH_STATE_INVALID',
      recovery,
      entityType: 'youtube_oauth',
      entityId: 'youtube',
      context: {
        callback: 'http://127.0.0.1:43123/oauth2callback?code=authorization-code&state=oauth-state',
        state: 'oauth-state',
        codeVerifier: 'pkce-verifier',
        accessToken: 'access-token',
        authorization: 'Bearer bearer-secret',
        operatorReason: 'I rotated arbitrary-private-value',
        priorError: 'provider returned arbitrary-error-detail',
        narrationText: 'private narration content',
        currentState: 'confirmation_required',
        channelStatus: 'unconfirmed'
      }
    });

    const row = db.raw.prepare(`
      SELECT action, actor, entity_type, entity_id, metadata_json
      FROM audit_log WHERE action = 'security.privileged_rejected'
    `).get() as {
      action: string;
      actor: string;
      entity_type: string;
      entity_id: string;
      metadata_json: string;
    };
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    expect(row).toMatchObject({
      action: 'security.privileged_rejected',
      actor: 'system',
      entity_type: 'youtube_oauth',
      entity_id: 'youtube'
    });
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      event: 'privileged_rejection',
      outcome: 'rejected',
      flow: 'oauth',
      operation: 'callback.state_validation',
      code: 'OAUTH_STATE_INVALID',
      recovery,
      context: {
        state: '[REDACTED]',
        codeVerifier: '[REDACTED]',
        accessToken: '[REDACTED]',
        authorization: '[REDACTED]',
        operatorReason: '[REDACTED]',
        priorError: '[REDACTED]',
        narrationText: '[REDACTED]',
        currentState: 'confirmation_required',
        channelStatus: 'unconfirmed'
      }
    });
    for (const secret of [
      'authorization-code', 'oauth-state', 'pkce-verifier', 'access-token', 'bearer-secret',
      'arbitrary-private-value', 'arbitrary-error-detail', 'private narration content'
    ]) expect(row.metadata_json).not.toContain(secret);
    expect(row.metadata_json).toContain('/oauth2callback?[REDACTED]');

    expect(() => rejectPrivilegedOperation(db, {
      flow: 'media_tool',
      operation: 'execution.identity_check',
      code: 'MEDIA_TOOL_IDENTITY_CHANGED',
      recovery: 'Inspect the executable again and explicitly confirm its new identity.',
      entityType: 'media_tool',
      entityId: 'ffmpeg'
    }, 'The trusted executable identity changed.')).toThrow(PrivilegedOperationError);
    try {
      rejectPrivilegedOperation(db, {
        flow: 'retry',
        operation: 'manual_retry.state_check',
        code: 'JOB_RETRY_INVALID_STATE',
        recovery: 'Refresh the job and use the action allowed for its current state.',
        entityType: 'job',
        entityId: 'job-1'
      }, 'The job cannot be retried from its current state.');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'JOB_RETRY_INVALID_STATE',
        recovery: 'Refresh the job and use the action allowed for its current state.'
      });
      expect(String(error)).toContain('[JOB_RETRY_INVALID_STATE]');
      expect(String(error)).toContain('Recovery:');
    }
    db.close();
  });
});
