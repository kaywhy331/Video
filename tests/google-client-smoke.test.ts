import { describe, expect, it } from 'vitest';
import { google } from 'googleapis';

describe('Google provider client compatibility', () => {
  it('constructs the OAuth, YouTube, Analytics, and Sheets clients without network access', () => {
    const auth = new google.auth.OAuth2('fixture-client', 'fixture-secret', 'http://127.0.0.1/callback');
    auth.setCredentials({ refresh_token: 'fixture-refresh-token' });

    expect(google.youtube({ version: 'v3', auth }).videos).toBeDefined();
    expect(google.youtubeAnalytics({ version: 'v2', auth }).reports).toBeDefined();
    expect(google.sheets({ version: 'v4', auth }).spreadsheets.values).toBeDefined();
  });
});
