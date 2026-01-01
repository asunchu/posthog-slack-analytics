import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';

// ============ Types ============

interface InstagramMedia {
  id: string;
  caption?: string;
  media_type: string;
  permalink: string;
  timestamp: string;
  like_count?: number;
  comments_count?: number;
  username?: string;
  owner?: {
    id: string;
    username: string;
  };
}

interface InstagramUser {
  id: string;
  username: string;
  name?: string;
  biography?: string;
  followers_count?: number;
  media_count?: number;
  profile_picture_url?: string;
}

interface TrendingContent {
  hashtag: string;
  topPosts: InstagramMedia[];
  recentPosts: InstagramMedia[];
}

interface Influencer {
  username: string;
  followers: number;
  bio?: string;
  profileUrl: string;
  recentEngagement: number;
  relevanceScore: number;
  reason: string;
}

interface ResearchInsights {
  trendingSummary: string;
  contentIdeas: string[];
  influencersToReach: Influencer[];
  keyThemes: string[];
  actionItems: string[];
}

// ============ Instagram Client ============

class InstagramClient {
  private accessToken: string;
  private businessAccountId: string;
  private baseUrl = 'https://graph.facebook.com/v18.0';

  constructor() {
    this.accessToken = process.env.INSTAGRAM_ACCESS_TOKEN!;
    this.businessAccountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID!;
  }

  private async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    url.searchParams.set('access_token', this.accessToken);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

    const response = await fetch(url.toString());
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Instagram API error: ${response.status} - ${error}`);
    }
    return response.json();
  }

  async searchHashtag(hashtag: string): Promise<{ id: string }> {
    return this.fetch(`/ig_hashtag_search`, {
      user_id: this.businessAccountId,
      q: hashtag,
    });
  }

  async getHashtagMedia(hashtagId: string, type: 'top' | 'recent' = 'top'): Promise<{ data: InstagramMedia[] }> {
    const edge = type === 'top' ? 'top_media' : 'recent_media';
    return this.fetch(`/${hashtagId}/${edge}`, {
      user_id: this.businessAccountId,
      fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count',
    });
  }

  async getMediaDetails(mediaId: string): Promise<InstagramMedia> {
    return this.fetch(`/${mediaId}`, {
      fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count,owner{id,username}',
    });
  }

  async getUserProfile(userId: string): Promise<InstagramUser> {
    return this.fetch(`/${userId}`, {
      fields: 'id,username,name,biography,followers_count,media_count,profile_picture_url',
    });
  }

  async getTrendingContent(hashtags: string[]): Promise<TrendingContent[]> {
    const results: TrendingContent[] = [];

    for (const hashtag of hashtags.slice(0, 5)) { // Limit to 5 hashtags per run
      try {
        const searchResult = await this.searchHashtag(hashtag);
        const hashtagId = (searchResult as any).data?.[0]?.id;

        if (!hashtagId) continue;

        const [topMedia, recentMedia] = await Promise.all([
          this.getHashtagMedia(hashtagId, 'top'),
          this.getHashtagMedia(hashtagId, 'recent'),
        ]);

        // Enrich with owner details
        const enrichedTop = await Promise.all(
          topMedia.data.slice(0, 5).map(async (media) => {
            try {
              return await this.getMediaDetails(media.id);
            } catch {
              return media;
            }
          })
        );

        results.push({
          hashtag,
          topPosts: enrichedTop,
          recentPosts: recentMedia.data.slice(0, 10),
        });

        // Rate limiting pause
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`Error fetching hashtag ${hashtag}:`, error);
      }
    }

    return results;
  }

  async discoverInfluencers(content: TrendingContent[]): Promise<Influencer[]> {
    const userIds = new Set<string>();
    const influencers: Influencer[] = [];

    // Collect unique user IDs from content
    for (const { topPosts, recentPosts } of content) {
      [...topPosts, ...recentPosts].forEach(post => {
        if (post.owner?.id) userIds.add(post.owner.id);
      });
    }

    // Fetch user profiles and filter by follower count (10K-25K)
    for (const userId of Array.from(userIds).slice(0, 20)) {
      try {
        const profile = await this.getUserProfile(userId);
        const followers = profile.followers_count || 0;

        if (followers >= 10000 && followers <= 25000) {
          // Calculate engagement from their recent posts in our data
          const userPosts = content
            .flatMap(c => [...c.topPosts, ...c.recentPosts])
            .filter(p => p.owner?.id === userId);

          const avgEngagement = userPosts.reduce((sum, p) =>
            sum + (p.like_count || 0) + (p.comments_count || 0), 0) / Math.max(userPosts.length, 1);

          influencers.push({
            username: profile.username,
            followers,
            bio: profile.biography,
            profileUrl: `https://instagram.com/${profile.username}`,
            recentEngagement: Math.round(avgEngagement),
            relevanceScore: 0, // Will be set by AI
            reason: '', // Will be set by AI
          });
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        console.error(`Error fetching user ${userId}:`, error);
      }
    }

    return influencers;
  }
}

// ============ AI Analysis ============

async function analyzeWithClaude(
  content: TrendingContent[],
  influencers: Influencer[]
): Promise<ResearchInsights> {
  const anthropic = new Anthropic();

  const contentSummary = content.map(c => ({
    hashtag: c.hashtag,
    topCaptions: c.topPosts.slice(0, 3).map(p => p.caption?.substring(0, 200)),
    recentCaptions: c.recentPosts.slice(0, 5).map(p => p.caption?.substring(0, 200)),
  }));

  const influencerSummary = influencers.map(i => ({
    username: i.username,
    followers: i.followers,
    bio: i.bio?.substring(0, 150),
    engagement: i.recentEngagement,
  }));

  const prompt = `You are a social media researcher for VākJournal, a voice-first journaling app for founders, creators, and leaders who "think out loud."

App Context:
- VākJournal transforms voice thoughts into structured insights and growth moments
- Target audience: Founders, creators, leaders, executives
- Key themes: Voice journaling, mental clarity, personal growth, reflection, productivity

Analyze this Instagram research data and provide insights:

## Trending Content by Hashtag:
${JSON.stringify(contentSummary, null, 2)}

## Potential Influencers (10K-25K followers):
${JSON.stringify(influencerSummary, null, 2)}

Provide your analysis in this exact JSON format:
{
  "trendingSummary": "2-3 sentence summary of what's trending in journaling/personal growth content",
  "contentIdeas": [
    "5 specific content ideas for VākJournal's Instagram, based on trends"
  ],
  "keyThemes": [
    "Top 5 themes/topics that are resonating with audiences"
  ],
  "influencerAnalysis": [
    {
      "username": "username",
      "relevanceScore": 1-10,
      "reason": "Why they're a good fit for VākJournal partnership"
    }
  ],
  "actionItems": [
    "3-5 specific actions to take this week based on this research"
  ]
}

Focus on actionable insights for VākJournal. Be specific about why each influencer would be a good fit.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse AI response');
  }

  const analysis = JSON.parse(jsonMatch[0]);

  // Merge AI analysis with influencer data
  const enrichedInfluencers = influencers.map(inf => {
    const aiAnalysis = analysis.influencerAnalysis?.find(
      (a: any) => a.username.toLowerCase() === inf.username.toLowerCase()
    );
    return {
      ...inf,
      relevanceScore: aiAnalysis?.relevanceScore || 5,
      reason: aiAnalysis?.reason || 'Active in journaling/productivity space',
    };
  }).sort((a, b) => b.relevanceScore - a.relevanceScore);

  return {
    trendingSummary: analysis.trendingSummary,
    contentIdeas: analysis.contentIdeas || [],
    influencersToReach: enrichedInfluencers.slice(0, 5),
    keyThemes: analysis.keyThemes || [],
    actionItems: analysis.actionItems || [],
  };
}

// ============ Slack Formatting ============

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
  divider: (): SlackBlock => ({ type: 'divider' }),
  context: (items: string[]): SlackBlock => ({
    type: 'context', elements: items.map(text => ({ type: 'mrkdwn', text })),
  }),
};

function formatSlackReport(insights: ResearchInsights): SlackBlock[] {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  return [
    blocks.header('📸 Instagram Research Report'),
    blocks.context([`VākJournal Content Research | ${today}`]),
    blocks.divider(),

    // Trending Summary
    blocks.section('*🔥 What\'s Trending*'),
    blocks.section(insights.trendingSummary),
    blocks.divider(),

    // Key Themes
    blocks.section('*🎯 Key Themes*'),
    blocks.section(insights.keyThemes.map((t, i) => `${i + 1}. ${t}`).join('\n')),
    blocks.divider(),

    // Content Ideas
    blocks.section('*💡 Content Ideas for VākJournal*'),
    blocks.section(insights.contentIdeas.map((idea, i) => `${i + 1}. ${idea}`).join('\n\n')),
    blocks.divider(),

    // Influencers to Reach
    blocks.section('*🤝 Influencers to Reach Out (10K-25K)*'),
    blocks.section(
      insights.influencersToReach.length > 0
        ? insights.influencersToReach.map(inf =>
            `*<${inf.profileUrl}|@${inf.username}>* (${(inf.followers / 1000).toFixed(1)}K)\n` +
            `Score: ${'⭐'.repeat(Math.min(inf.relevanceScore, 5))} | ${inf.reason}`
          ).join('\n\n')
        : '_No influencers found in target range_'
    ),
    blocks.divider(),

    // Action Items
    blocks.section('*✅ This Week\'s Action Items*'),
    blocks.section(insights.actionItems.map(item => `• ${item}`).join('\n')),
    blocks.divider(),

    blocks.context(['🤖 Generated by VākJournal Instagram Research Agent']),
  ];
}

async function sendToSlack(slackBlocks: SlackBlock[]): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL!;
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks: slackBlocks, text: 'Instagram Research Report' }),
  });
  if (!response.ok) {
    throw new Error(`Slack error: ${response.status}`);
  }
}

// ============ Main Handler ============

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('Starting Instagram research...');

    const instagram = new InstagramClient();
    const hashtags = (process.env.HASHTAGS || 'journaling,bulletjournal,voicejournal,morningpages,journalprompts').split(',');

    // Step 1: Fetch trending content
    console.log('Fetching trending content...');
    const trendingContent = await instagram.getTrendingContent(hashtags);

    // Step 2: Discover influencers
    console.log('Discovering influencers...');
    const influencers = await instagram.discoverInfluencers(trendingContent);

    // Step 3: AI analysis
    console.log('Analyzing with Claude...');
    const insights = await analyzeWithClaude(trendingContent, influencers);

    // Step 4: Send to Slack
    console.log('Sending report to Slack...');
    const slackBlocks = formatSlackReport(insights);
    await sendToSlack(slackBlocks);

    console.log('Research complete!');
    return res.status(200).json({ success: true, message: 'Research report sent to Slack' });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
