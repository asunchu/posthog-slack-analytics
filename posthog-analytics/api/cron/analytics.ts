import type { VercelRequest, VercelResponse } from '@vercel/node';

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

class PostHogClient {
  private apiKey: string;
  private projectId: string;
  private host: string;

  constructor() {
    this.apiKey = process.env.POSTHOG_API_KEY!;
    this.projectId = process.env.POSTHOG_PROJECT_ID!;
    this.host = process.env.POSTHOG_HOST || 'https://us.posthog.com';
  }

  private async query<T>(sql: string, name: string): Promise<QueryResult<T>> {
    const url = `${this.host}/api/projects/${this.projectId}/query`;

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

  async getVisitToAppStoreFunnel(days: number = 1): Promise<{ visitors: number; appStoreClicks: number; conversionRate: number }> {
    const query = `
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
    const result = await this.query<[number, number]>(query, 'visit_to_app_store_funnel');
    const [visitors, appStoreClicks] = result.results[0] || [0, 0];
    const conversionRate = visitors > 0 ? Math.round((appStoreClicks / visitors) * 1000) / 10 : 0;
    return { visitors, appStoreClicks, conversionRate };
  }

  async getAppStoreCtaClicks(days: number = 1): Promise<{ clicks: number; uniqueUsers: number }> {
    const query = `
      SELECT count() as clicks, uniq(distinct_id) as unique_users
      FROM events
      WHERE timestamp >= now() - interval ${days} day
        AND (
          -- Custom event for App Store clicks
          event = 'app_store_click'
          OR event = 'app_store_cta_click'
          -- Or autocaptured clicks on App Store buttons/links
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
    `;
    const result = await this.query<[number, number]>(query, 'app_store_cta_clicks');
    const [clicks, uniqueUsers] = result.results[0] || [0, 0];
    return { clicks, uniqueUsers };
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return url.substring(0, 30);
    }
  }
}

// ============ Slack Client ============

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

async function sendToSlack(slackBlocks: SlackBlock[]): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL!;
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks: slackBlocks, text: 'Daily Analytics Report' }),
  });
  if (!response.ok) {
    throw new Error(`Slack error: ${response.status}`);
  }
}

// ============ Formatting ============

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

// ============ Main Handler ============

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret (optional but recommended)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const days = 1; // Daily report
    const posthog = new PostHogClient();

    console.log('Fetching analytics data...');
    const [traffic, channels, referrers, topPages, actions, clicks, appStoreCta, funnel] = await Promise.all([
      posthog.getTrafficOverview(days),
      posthog.getChannels(days),
      posthog.getTopReferrers(days),
      posthog.getTopPages(days),
      posthog.getTopActions(days),
      posthog.getClickEvents(days),
      posthog.getAppStoreCtaClicks(days),
      posthog.getVisitToAppStoreFunnel(days),
    ]);

    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const slackBlocks: SlackBlock[] = [
      blocks.header(':bar_chart: Daily Analytics Report'),
      blocks.context([today]),
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

      // Conversion Funnel
      blocks.section('*:funnel: Visit → App Store Funnel*'),
      blocks.section(
        `*Step 1:* Visit Site → *${formatNumber(funnel.visitors)}* users\n` +
        `${'█'.repeat(20)} 100%\n\n` +
        `*Step 2:* App Store Click → *${formatNumber(funnel.appStoreClicks)}* users\n` +
        `${'█'.repeat(Math.max(1, Math.round(funnel.conversionRate / 5)))}${'░'.repeat(20 - Math.max(1, Math.round(funnel.conversionRate / 5)))} ${funnel.conversionRate}%`
      ),
      blocks.context([`Conversion rate: ${funnel.conversionRate}% | Total clicks: ${formatNumber(appStoreCta.clicks)}`]),
      blocks.divider(),

      // Channels
      blocks.section('*:satellite_antenna: Traffic Channels*'),
      blocks.section(channels.length > 0
        ? channels.map((c, i) => `${i + 1}. *${c.channel}* - ${formatNumber(c.sessions)} sessions (${c.percentage}%)`).join('\n')
        : '_No channel data available_'),
      blocks.divider(),

      // Referrers
      blocks.section('*:link: Top Referrers*'),
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

      // Actions
      blocks.section('*:zap: Custom Actions*'),
      blocks.section(actions.length > 0
        ? actions.map((a, i) => `${i + 1}. *${a.event}* - ${formatNumber(a.count)} times`).join('\n')
        : '_No custom actions tracked_'),

      // Clicks
      blocks.section('*:point_up_2: Top Clicked Elements*'),
      blocks.section(clicks.length > 0
        ? clicks.map((c, i) => `${i + 1}. "${c.event}" - ${formatNumber(c.count)} clicks`).join('\n')
        : '_No click data available_'),
      blocks.divider(),

      // Insights
      blocks.section('*:crystal_ball: Key Insights*'),
    ];

    // Generate insights
    const insights: string[] = [];
    const pvChange = ((traffic.pageviews - traffic.previousPageviews) / traffic.previousPageviews) * 100;
    if (pvChange > 20) insights.push(`:rocket: Traffic spike! Pageviews up ${pvChange.toFixed(0)}% vs yesterday.`);
    else if (pvChange < -20) insights.push(`:warning: Traffic drop. Pageviews down ${Math.abs(pvChange).toFixed(0)}% vs yesterday.`);
    if (traffic.bounceRate > 70) insights.push(`:thinking_face: High bounce rate (${traffic.bounceRate}%). Consider improving landing pages.`);
    if (topPages.length > 0) insights.push(`:trophy: Top page: \`${topPages[0].url}\` with ${formatNumber(topPages[0].views)} views.`);

    slackBlocks.push(blocks.section(insights.length > 0 ? insights.join('\n\n') : '_No notable insights today_'));
    slackBlocks.push(blocks.divider());
    slackBlocks.push(blocks.context([':robot_face: Generated by PostHog Analytics Bot']));

    await sendToSlack(slackBlocks);
    console.log('Report sent to Slack!');

    return res.status(200).json({ success: true, message: 'Report sent to Slack' });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
