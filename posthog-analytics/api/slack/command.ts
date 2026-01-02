import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

// ============ PostHog Client ============

interface QueryResult<T> {
  results: T[];
  columns: string[];
}

interface TrafficOverview {
  pageviews: number;
  uniqueVisitors: number;
  sessions: number;
  avgSessionDuration: number;
  bounceRate: number;
  previousPageviews: number;
  previousUniqueVisitors: number;
}

interface ChannelData {
  channel: string;
  sessions: number;
  percentage: number;
}

interface ReferrerData {
  referrer: string;
  sessions: number;
}

interface TopPage {
  url: string;
  views: number;
}

interface ActionData {
  event: string;
  count: number;
}

interface DynamicLinkData {
  total: number;
  ios: number;
  android: number;
  web: number;
  sources: Array<{ source: string; count: number }>;
}

class PostHogClient {
  private apiKey: string;
  private projectId: string;
  private installsProjectId: string;
  private host: string;

  constructor() {
    this.apiKey = process.env.POSTHOG_API_KEY!;
    this.projectId = process.env.POSTHOG_PROJECT_ID!;
    this.installsProjectId = process.env.POSTHOG_INSTALLS_PROJECT_ID!;
    this.host = process.env.POSTHOG_HOST || 'https://us.posthog.com';
  }

  private async query<T>(sql: string, name: string, projectId?: string): Promise<QueryResult<T>> {
    const url = `${this.host}/api/projects/${projectId || this.projectId}/query`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query: { kind: 'HogQLQuery', query: sql, name },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`PostHog API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  async getTrafficOverview(days: number = 1): Promise<TrafficOverview> {
    const currentQuery = `
      SELECT count() as pageviews, uniq(distinct_id) as unique_visitors, uniq(properties.$session_id) as sessions
      FROM events WHERE event = '$pageview' AND timestamp >= now() - interval ${days} day AND timestamp < now()
    `;
    const previousQuery = `
      SELECT count() as pageviews, uniq(distinct_id) as unique_visitors
      FROM events WHERE event = '$pageview' AND timestamp >= now() - interval ${days * 2} day AND timestamp < now() - interval ${days} day
    `;
    const sessionQuery = `
      SELECT avg(duration) as avg_duration, countIf(pageview_count = 1) / count() * 100 as bounce_rate
      FROM (
        SELECT properties.$session_id as session_id, dateDiff('second', min(timestamp), max(timestamp)) as duration, count() as pageview_count
        FROM events WHERE event = '$pageview' AND timestamp >= now() - interval ${days} day AND properties.$session_id IS NOT NULL
        GROUP BY session_id
      )
    `;

    const [current, previous, sessionStats] = await Promise.all([
      this.query<[number, number, number]>(currentQuery, 'current_traffic'),
      this.query<[number, number]>(previousQuery, 'previous_traffic'),
      this.query<[number, number]>(sessionQuery, 'session_stats'),
    ]);

    const [pageviews, uniqueVisitors, sessions] = current.results[0] || [0, 0, 0];
    const [previousPageviews, previousUniqueVisitors] = previous.results[0] || [0, 0];
    const [avgSessionDuration, bounceRate] = sessionStats.results[0] || [0, 0];

    return {
      pageviews, uniqueVisitors, sessions,
      avgSessionDuration: Math.round(avgSessionDuration),
      bounceRate: Math.round(bounceRate * 10) / 10,
      previousPageviews, previousUniqueVisitors,
    };
  }

  async getChannels(days: number = 1): Promise<ChannelData[]> {
    const query = `
      SELECT properties.$channel_type as channel, uniq(properties.$session_id) as sessions
      FROM events WHERE event = '$pageview' AND timestamp >= now() - interval ${days} day AND properties.$channel_type IS NOT NULL
      GROUP BY channel ORDER BY sessions DESC LIMIT 5
    `;
    const result = await this.query<[string, number]>(query, 'channels');
    const total = result.results.reduce((sum, [, s]) => sum + s, 0);
    return result.results.map(([channel, sessions]) => ({
      channel: channel || 'Direct', sessions, percentage: Math.round((sessions / total) * 100),
    }));
  }

  async getTopReferrers(days: number = 1): Promise<ReferrerData[]> {
    const query = `
      SELECT properties.$referrer as referrer, uniq(properties.$session_id) as sessions
      FROM events WHERE event = '$pageview' AND timestamp >= now() - interval ${days} day
        AND properties.$referrer IS NOT NULL AND properties.$referrer != ''
      GROUP BY referrer ORDER BY sessions DESC LIMIT 5
    `;
    const result = await this.query<[string, number]>(query, 'referrers');
    return result.results.map(([referrer, sessions]) => ({
      referrer: this.extractDomain(referrer), sessions,
    }));
  }

  async getTopPages(days: number = 1): Promise<TopPage[]> {
    const query = `
      SELECT properties.$pathname as url, count() as views
      FROM events WHERE event = '$pageview' AND timestamp >= now() - interval ${days} day
      GROUP BY url ORDER BY views DESC LIMIT 5
    `;
    const result = await this.query<[string, number]>(query, 'top_pages');
    return result.results.map(([url, views]) => ({ url: url || '/', views }));
  }

  async getTopActions(days: number = 1): Promise<ActionData[]> {
    const query = `
      SELECT event, count() as count FROM events
      WHERE timestamp >= now() - interval ${days} day AND event NOT LIKE '$%'
      GROUP BY event ORDER BY count DESC LIMIT 5
    `;
    const result = await this.query<[string, number]>(query, 'top_actions');
    return result.results.map(([event, count]) => ({ event, count }));
  }

  async getClickEvents(days: number = 1): Promise<ActionData[]> {
    const query = `
      SELECT coalesce(properties.$el_text, properties.element_text, 'Unknown') as element, count() as count
      FROM events WHERE event = '$autocapture' AND timestamp >= now() - interval ${days} day
        AND (properties.$event_type = 'click' OR properties.event_type = 'click')
      GROUP BY element ORDER BY count DESC LIMIT 5
    `;
    const result = await this.query<[string, number]>(query, 'click_events');
    return result.results.map(([event, count]) => ({
      event: event.substring(0, 30) + (event.length > 30 ? '...' : ''), count,
    }));
  }

  async getVisitToInstallFunnel(days: number = 1): Promise<{
    visitors: number;
    appStoreClicks: number;
    installs: number;
    clickRate: number;
    installRate: number;
    overallConversion: number;
  }> {
    const webQuery = `
      WITH
        visitors AS (
          SELECT DISTINCT distinct_id
          FROM events
          WHERE event = '$pageview'
            AND timestamp >= now() - interval ${days} day
        ),
        app_store_clickers AS (
          SELECT DISTINCT distinct_id
          FROM events
          WHERE timestamp >= now() - interval ${days} day
            AND (
              event = 'app_store_click'
              OR event = 'app_store_cta_click'
              OR (
                event = '$autocapture'
                AND (properties.$event_type = 'click' OR properties.event_type = 'click')
                AND (
                  lower(coalesce(properties.$el_text, properties.element_text, '')) LIKE '%app store%'
                  OR lower(coalesce(properties.$el_text, properties.element_text, '')) LIKE '%download%app%'
                  OR lower(coalesce(properties.href, '')) LIKE '%apps.apple.com%'
                  OR lower(coalesce(properties.href, '')) LIKE '%play.google.com%'
                )
              )
            )
        )
      SELECT
        (SELECT count() FROM visitors) as visitors,
        (SELECT count() FROM app_store_clickers) as app_store_clickers
    `;

    const installsQuery = `
      SELECT uniq(distinct_id) as installs
      FROM events
      WHERE timestamp >= now() - interval ${days} day
        AND (
          event = 'Application Installed'
          OR event = 'app_installed'
          OR event = '$identify'
          OR event = 'install'
        )
    `;

    const [webResult, installsResult] = await Promise.all([
      this.query<[number, number]>(webQuery, 'web_funnel_steps'),
      this.query<[number]>(installsQuery, 'app_installs', this.installsProjectId),
    ]);

    const [visitors, appStoreClicks] = webResult.results[0] || [0, 0];
    const [installs] = installsResult.results[0] || [0];

    const clickRate = visitors > 0 ? Math.round((appStoreClicks / visitors) * 1000) / 10 : 0;
    const installRate = appStoreClicks > 0 ? Math.round((installs / appStoreClicks) * 1000) / 10 : 0;
    const overallConversion = visitors > 0 ? Math.round((installs / visitors) * 1000) / 10 : 0;

    return { visitors, appStoreClicks, installs, clickRate, installRate, overallConversion };
  }

  async getDynamicLinkStats(days: number = 1): Promise<DynamicLinkData> {
    const query = `
      SELECT
        count() as total,
        countIf(properties.platform = 'ios') as ios,
        countIf(properties.platform = 'android') as android,
        countIf(properties.platform NOT IN ('ios', 'android')) as web
      FROM events
      WHERE event = 'dynamic_link_clicked'
        AND timestamp >= now() - interval ${days} day
    `;

    const sourcesQuery = `
      SELECT properties.source as source, count() as count
      FROM events
      WHERE event = 'dynamic_link_clicked'
        AND timestamp >= now() - interval ${days} day
        AND properties.source IS NOT NULL
        AND properties.source != 'direct'
      GROUP BY source ORDER BY count DESC LIMIT 5
    `;

    const [stats, sources] = await Promise.all([
      this.query<[number, number, number, number]>(query, 'dynamic_link_stats', this.installsProjectId),
      this.query<[string, number]>(sourcesQuery, 'dynamic_link_sources', this.installsProjectId),
    ]);

    const [total, ios, android, web] = stats.results[0] || [0, 0, 0, 0];

    return {
      total, ios, android, web,
      sources: sources.results.map(([source, count]) => ({ source, count })),
    };
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return url.substring(0, 30);
    }
  }
}

// ============ Slack Helpers ============

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  fields?: Array<{ type: string; text: string }>;
  elements?: Array<{ type: string; text: string }>;
}

const blocks = {
  header: (text: string): SlackBlock => ({
    type: 'header', text: { type: 'plain_text', text, emoji: true },
  }),
  section: (text: string): SlackBlock => ({
    type: 'section', text: { type: 'mrkdwn', text },
  }),
  fields: (items: string[]): SlackBlock => ({
    type: 'section', fields: items.map(text => ({ type: 'mrkdwn', text })),
  }),
  divider: (): SlackBlock => ({ type: 'divider' }),
  context: (items: string[]): SlackBlock => ({
    type: 'context', elements: items.map(text => ({ type: 'mrkdwn', text })),
  }),
};

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toLocaleString();
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function percentChange(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? '+100%' : '0%';
  const change = ((current - previous) / previous) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
}

function trend(current: number, previous: number): string {
  if (current > previous) return ':chart_with_upwards_trend:';
  if (current < previous) return ':chart_with_downwards_trend:';
  return ':left_right_arrow:';
}

function parseDays(text: string): number {
  const match = text.trim().match(/^(\d+)\s*(d|day|days|w|week|weeks)?$/i);
  if (!match) return 1;

  const num = parseInt(match[1], 10);
  const unit = (match[2] || 'd').toLowerCase();

  if (unit.startsWith('w')) return num * 7;
  return num;
}

function verifySlackSignature(req: VercelRequest): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true; // Skip if not configured

  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const signature = req.headers['x-slack-signature'] as string;

  if (!timestamp || !signature) return false;

  // Check timestamp is within 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const body = typeof req.body === 'string' ? req.body : new URLSearchParams(req.body).toString();
  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = 'v0=' + crypto.createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
}

async function sendSlackResponse(responseUrl: string, slackBlocks: SlackBlock[]): Promise<void> {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      response_type: 'in_channel',
      blocks: slackBlocks,
    }),
  });
}

// ============ Main Handler ============

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify Slack signature
  if (!verifySlackSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { text = '', response_url, user_name } = req.body;
  const days = parseDays(text);
  const periodLabel = days === 1 ? 'Today' : `Last ${days} days`;

  // Acknowledge immediately (Slack requires response within 3 seconds)
  res.status(200).json({
    response_type: 'ephemeral',
    text: `:hourglass_flowing_sand: Fetching analytics for ${periodLabel.toLowerCase()}...`,
  });

  // Fetch and send analytics asynchronously
  try {
    const posthog = new PostHogClient();

    const [traffic, channels, referrers, topPages, actions, clicks, funnel, dynamicLinks] = await Promise.all([
      posthog.getTrafficOverview(days),
      posthog.getChannels(days),
      posthog.getTopReferrers(days),
      posthog.getTopPages(days),
      posthog.getTopActions(days),
      posthog.getClickEvents(days),
      posthog.getVisitToInstallFunnel(days),
      posthog.getDynamicLinkStats(days),
    ]);

    const slackBlocks: SlackBlock[] = [
      blocks.header(`:bar_chart: Analytics Report - ${periodLabel}`),
      blocks.context([`Requested by @${user_name}`]),
      blocks.divider(),

      // Traffic Overview
      blocks.section('*:busts_in_silhouette: Traffic Overview*'),
      blocks.fields([
        `*Pageviews*\n${formatNumber(traffic.pageviews)} ${trend(traffic.pageviews, traffic.previousPageviews)} ${percentChange(traffic.pageviews, traffic.previousPageviews)}`,
        `*Unique Visitors*\n${formatNumber(traffic.uniqueVisitors)} ${trend(traffic.uniqueVisitors, traffic.previousUniqueVisitors)} ${percentChange(traffic.uniqueVisitors, traffic.previousUniqueVisitors)}`,
        `*Sessions*\n${formatNumber(traffic.sessions)}`,
        `*Bounce Rate*\n${traffic.bounceRate}%`,
      ]),
      blocks.context([`Avg. session duration: ${formatDuration(traffic.avgSessionDuration)}`]),
      blocks.divider(),

      // Dynamic Link Stats
      blocks.section('*:link: Dynamic Link (link.vakapps.com)*'),
      blocks.fields([
        `*Total Clicks*\n${formatNumber(dynamicLinks.total)}`,
        `*iOS → App Store*\n${formatNumber(dynamicLinks.ios)}`,
        `*Android/Web*\n${formatNumber(dynamicLinks.android + dynamicLinks.web)}`,
      ]),
      ...(dynamicLinks.sources.length > 0 ? [
        blocks.context([`Top sources: ${dynamicLinks.sources.map(s => `${s.source} (${s.count})`).join(', ')}`]),
      ] : []),
      blocks.divider(),

      // Conversion Funnel
      blocks.section('*:funnel: Visit → App Store → Install Funnel*'),
      blocks.section(
        `*Step 1:* Visit Site → *${formatNumber(funnel.visitors)}* users\n` +
        `${'█'.repeat(20)} 100%\n\n` +
        `*Step 2:* App Store Click → *${formatNumber(funnel.appStoreClicks)}* users\n` +
        `${'█'.repeat(Math.max(1, Math.round(funnel.clickRate / 5)))}${'░'.repeat(20 - Math.max(1, Math.round(funnel.clickRate / 5)))} ${funnel.clickRate}%\n\n` +
        `*Step 3:* App Install → *${formatNumber(funnel.installs)}* users\n` +
        `${'█'.repeat(Math.max(1, Math.round(funnel.overallConversion / 5)))}${'░'.repeat(20 - Math.max(1, Math.round(funnel.overallConversion / 5)))} ${funnel.overallConversion}%`
      ),
      blocks.context([`Click rate: ${funnel.clickRate}% | Install rate: ${funnel.installRate}% | Overall: ${funnel.overallConversion}%`]),
      blocks.divider(),

      // Channels
      blocks.section('*:satellite_antenna: Traffic Channels*'),
      blocks.section(channels.length > 0
        ? channels.map((c, i) => `${i + 1}. *${c.channel}* - ${formatNumber(c.sessions)} sessions (${c.percentage}%)`).join('\n')
        : '_No channel data available_'),
      blocks.divider(),

      // Referrers
      blocks.section('*:globe_with_meridians: Top Referrers*'),
      blocks.section(referrers.length > 0
        ? referrers.map((r, i) => `${i + 1}. \`${r.referrer}\` - ${formatNumber(r.sessions)} sessions`).join('\n')
        : '_No referrer data available_'),
      blocks.divider(),

      // Top Pages
      blocks.section('*:page_facing_up: Top Pages*'),
      blocks.section(topPages.length > 0
        ? topPages.map((p, i) => `${i + 1}. \`${p.url}\` - ${formatNumber(p.views)} views`).join('\n')
        : '_No page data available_'),
      blocks.divider(),

      // Actions & Clicks side by side
      blocks.section('*:zap: Custom Actions*'),
      blocks.section(actions.length > 0
        ? actions.map((a, i) => `${i + 1}. *${a.event}* - ${formatNumber(a.count)}`).join('\n')
        : '_No custom actions tracked_'),

      blocks.section('*:point_up_2: Top Clicked Elements*'),
      blocks.section(clicks.length > 0
        ? clicks.map((c, i) => `${i + 1}. "${c.event}" - ${formatNumber(c.count)}`).join('\n')
        : '_No click data available_'),

      blocks.divider(),
      blocks.context([`:robot_face: Generated via \`/analytics${text ? ' ' + text : ''}\``]),
    ];

    await sendSlackResponse(response_url, slackBlocks);
  } catch (error) {
    console.error('Error fetching analytics:', error);
    await sendSlackResponse(response_url, [
      blocks.section(`:x: Error fetching analytics: ${error instanceof Error ? error.message : 'Unknown error'}`),
    ]);
  }
}
