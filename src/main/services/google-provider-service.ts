import type { Auth } from 'googleapis';
import type { AnalyticsProvider } from './analytics-service';
import type { AnalyticsCollectionRequest, AnalyticsProviderResult } from '@shared/types';
import type { SecretStore } from '../secret-store';
import { googleApis } from '../google-apis';
import type { SheetValuesReader } from './expansion-service';

interface AnalyticsQueryResponse {
  columnHeaders?: Array<{ name?: string }>;
  rows?: unknown[][];
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class GoogleProviderService implements AnalyticsProvider, SheetValuesReader {
  constructor(private readonly secrets: SecretStore) {}

  private async auth(): Promise<Auth.OAuth2Client> {
    const secret = this.secrets.getAll();
    if (!secret.youtubeClientId || !secret.youtubeClientSecret) {
      throw new Error('Google OAuth client ID and secret are not configured.');
    }
    if (!secret.youtubeRefreshToken && !secret.youtubeAccessToken) {
      throw new Error('Google OAuth authorization is required.');
    }
    const auth = new (googleApis().google.auth.OAuth2)(secret.youtubeClientId, secret.youtubeClientSecret);
    auth.setCredentials({
      refresh_token: secret.youtubeRefreshToken,
      access_token: secret.youtubeAccessToken,
      expiry_date: secret.youtubeTokenExpiry
    });
    auth.on('tokens', tokens => {
      this.secrets.update({
        youtubeAccessToken: tokens.access_token ?? undefined,
        youtubeRefreshToken: tokens.refresh_token ?? secret.youtubeRefreshToken,
        youtubeTokenExpiry: tokens.expiry_date ?? undefined
      });
    });
    return auth;
  }

  async getValues(spreadsheetId: string, sheetRange: string): Promise<unknown[][]> {
    const auth = await this.auth();
    const sheets = googleApis().google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: sheetRange,
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING'
    });
    return (response.data.values ?? []) as unknown[][];
  }

  async collect(request: AnalyticsCollectionRequest): Promise<AnalyticsProviderResult> {
    const auth = await this.auth();
    const analytics = googleApis().google.youtubeAnalytics({ version: 'v2', auth });
    const channelQuery = await analytics.reports.query({
      ids: 'channel==MINE',
      startDate: request.startDate,
      endDate: request.endDate,
      metrics: [
        'views', 'estimatedMinutesWatched', 'averageViewDuration',
        'averageViewPercentage', 'subscribersGained'
      ].join(','),
      filters: `video==${request.videoId}`
    });
    const performance = channelQuery.data as AnalyticsQueryResponse;
    const values = this.rowObject(performance);

    const trafficQuery = await analytics.reports.query({
      ids: 'channel==MINE',
      startDate: request.startDate,
      endDate: request.endDate,
      dimensions: 'insightTrafficSourceType',
      metrics: 'views',
      filters: `video==${request.videoId}`,
      maxResults: 200
    });
    const trafficSources = this.dimensionMap(trafficQuery.data as AnalyticsQueryResponse);

    const searchQuery = await analytics.reports.query({
      ids: 'channel==MINE',
      startDate: request.startDate,
      endDate: request.endDate,
      dimensions: 'insightTrafficSourceDetail',
      metrics: 'views',
      filters: `video==${request.videoId};insightTrafficSourceType==YT_SEARCH`,
      maxResults: 200
    });
    const searchTerms = this.dimensionMap(searchQuery.data as AnalyticsQueryResponse);

    const retentionQuery = await analytics.reports.query({
      ids: 'channel==MINE',
      startDate: request.startDate,
      endDate: request.endDate,
      dimensions: 'elapsedVideoTimeRatio',
      metrics: 'audienceWatchRatio,relativeRetentionPerformance',
      filters: `video==${request.videoId}`,
      sort: 'elapsedVideoTimeRatio',
      maxResults: 200
    });
    const retention = this.retention(retentionQuery.data as AnalyticsQueryResponse);

    const youtube = googleApis().google.youtube({ version: 'v3', auth });
    const video = await youtube.videos.list({ part: ['statistics'], id: [request.videoId] });
    const statistics = video.data.items?.[0]?.statistics;
    const views = Number(statistics?.viewCount ?? values.views ?? 0);

    return {
      metrics: {
        views: Number.isFinite(views) ? Math.max(0, Math.round(views)) : 0,
        impressions: null,
        clickThroughRate: null,
        watchTimeMinutes: number(values.estimatedMinutesWatched),
        averageViewDurationSeconds: number(values.averageViewDuration),
        averagePercentageViewed: number(values.averageViewPercentage) === null
          ? null : Math.max(0, Math.min(1, Number(values.averageViewPercentage) / 100)),
        subscribersGained: number(values.subscribersGained) === null
          ? null : Math.round(number(values.subscribersGained)!),
        trafficSources,
        searchTerms,
        playlistStarts: null,
        endScreenClicks: null
      },
      retention,
      rawMetadata: {
        provider: 'youtube_analytics',
        requestedMetrics: Object.keys(values),
        impressionsUnavailable: true,
        clickThroughRateUnavailable: true
      }
    };
  }

  async publicationStatus(videoId: string): Promise<{
    isPublic: boolean;
    privacyStatus: string | null;
    publishedAt: string | null;
  }> {
    const auth = await this.auth();
    const youtube = googleApis().google.youtube({ version: 'v3', auth });
    const response = await youtube.videos.list({
      part: ['status', 'snippet'],
      id: [videoId]
    });
    const video = response.data.items?.[0];
    if (!video) throw new Error('The scheduled YouTube video could not be found.');
    const privacyStatus = video.status?.privacyStatus ?? null;
    return {
      isPublic: privacyStatus === 'public',
      privacyStatus,
      publishedAt: video.snippet?.publishedAt ?? null
    };
  }

  private rowObject(response: AnalyticsQueryResponse): Record<string, unknown> {
    const headers = response.columnHeaders ?? [];
    const row = response.rows?.[0] ?? [];
    return Object.fromEntries(headers.map((header, index) => [header.name ?? `column_${index}`, row[index]]));
  }

  private dimensionMap(response: AnalyticsQueryResponse): Record<string, number> {
    const result: Record<string, number> = {};
    for (const row of response.rows ?? []) {
      const key = String(row[0] ?? '').trim();
      const value = number(row[1]);
      if (key && value !== null) result[key] = value;
    }
    return result;
  }

  private retention(response: AnalyticsQueryResponse): AnalyticsProviderResult['retention'] {
    const headers = (response.columnHeaders ?? []).map(header => header.name ?? '');
    const elapsedIndex = headers.indexOf('elapsedVideoTimeRatio');
    const audienceIndex = headers.indexOf('audienceWatchRatio');
    const relativeIndex = headers.indexOf('relativeRetentionPerformance');
    return (response.rows ?? []).flatMap(row => {
      const elapsed = number(row[elapsedIndex]);
      if (elapsed === null || elapsed < 0 || elapsed > 1) return [];
      return [{
        elapsedRatio: elapsed,
        audienceWatchRatio: number(row[audienceIndex]),
        relativeRetention: number(row[relativeIndex])
      }];
    });
  }
}
