import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';

// ============ Types ============

interface ApifyPost {
  id: string;
  shortCode: string;
  caption?: string;
  url: string;
  timestamp: string;
  likesCount: number;
  commentsCount: number;
  ownerUsername: string;
  ownerId: string;
  hashtags?: string[];
  type: string;
}

interface ApifyProfile {
  id: string;
  username: string;
  fullName?: string;
  biography?: string;
  followersCount: number;
  followsCount: number;
  postsCount: number;
  profilePicUrl?: string;
  isVerified: boolean;
  externalUrl?: string;
}

interface TrendingContent {
  hashtag: string;
  posts: ApifyPost[];
}

interface Influencer {
  username: string;
  followers: number;
  bio?: string;
  profileUrl: string;
  engagement: number;
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

// ============ Apify Client ============

class ApifyClient {
  private apiToken: string;
  private baseUrl = 'https://api.apify.com/v2';

  constructor() {
    this.apiToken = process.env.APIFY_API_TOKEN!;
  }

  private async runActor<T>(actorId: string, input: Record<string, any>): Promise<T[]> {
    // Start the actor run
    const runResponse = await fetch(
      `${this.baseUrl}/acts/${actorId}/runs?token=${this.apiToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }
    );

    if (!runResponse.ok) {
      throw new Error(`Apify run error: ${runResponse.status}`);
    }

    const runData = await runResponse.json();
    const runId = runData.data.id;

    // Wait for completion (poll every 5 seconds, max 2 minutes)
    let status = runData.data.status;
    let attempts = 0;
    while (status !== 'SUCCEEDED' && status !== 'FAILED' && attempts < 24) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const statusResponse = await fetch(
        `${this.baseUrl}/actor-runs/${runId}?token=${this.apiToken}`
      );
      const statusData = await statusResponse.json();
      status = statusData.data.status;
      attempts++;
    }

    if (status !== 'SUCCEEDED') {
      throw new Error(`Apify run failed with status: ${status}`);
    }

    // Get results from dataset
    const datasetId = runData.data.defaultDatasetId;
    const resultsResponse = await fetch(
      `${this.baseUrl}/datasets/${datasetId}/items?token=${this.apiToken}`
    );

    if (!resultsResponse.ok) {
      throw new Error(`Apify results error: ${resultsResponse.status}`);
    }

    return resultsResponse.json();
  }

  async searchHashtags(hashtags: string[], postsPerHashtag: number = 20): Promise<TrendingContent[]> {
    const results: TrendingContent[] = [];

    // Use Apify's Instagram Hashtag Scraper
    // Actor: apify/instagram-hashtag-scraper
    for (const hashtag of hashtags) {
      try {
        const posts = await this.runActor<ApifyPost>('apify~instagram-hashtag-scraper', {
          hashtags: [hashtag],
          resultsLimit: postsPerHashtag,
          resultsType: 'posts',
        });

        results.push({ hashtag, posts });
        console.log(`Fetched ${posts.length} posts for #${hashtag}`);
      } catch (error) {
        console.error(`Error fetching #${hashtag}:`, error);
      }
    }

    return results;
  }

  async getProfiles(usernames: string[]): Promise<ApifyProfile[]> {
    if (usernames.length === 0) return [];

    try {
      // Use Apify's Instagram Profile Scraper
      // Actor: apify/instagram-profile-scraper
      const profiles = await this.runActor<ApifyProfile>('apify~instagram-profile-scraper', {
        usernames: usernames.slice(0, 20), // Limit to 20 profiles
      });

      return profiles;
    } catch (error) {
      console.error('Error fetching profiles:', error);
      return [];
    }
  }

  async discoverInfluencers(content: TrendingContent[]): Promise<Influencer[]> {
    // Extract unique usernames from posts
    const usernames = new Set<string>();
    content.forEach(({ posts }) => {
      posts.forEach(post => {
        if (post.ownerUsername) usernames.add(post.ownerUsername);
      });
    });

    // Fetch profiles
    const profiles = await this.getProfiles(Array.from(usernames));

    // Filter to target range (10K-25K followers)
    const targetInfluencers = profiles
      .filter(p => p.followersCount >= 10000 && p.followersCount <= 25000)
      .map(profile => {
        // Calculate engagement from posts we have
        const userPosts = content
          .flatMap(c => c.posts)
          .filter(p => p.ownerUsername === profile.username);

        const totalEngagement = userPosts.reduce(
          (sum, p) => sum + p.likesCount + p.commentsCount, 0
        );
        const avgEngagement = userPosts.length > 0
          ? totalEngagement / userPosts.length
          : 0;

        return {
          username: profile.username,
          followers: profile.followersCount,
          bio: profile.biography,
          profileUrl: `https://instagram.com/${profile.username}`,
          engagement: Math.round(avgEngagement),
          relevanceScore: 0,
          reason: '',
        };
      });

    return targetInfluencers;
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
    postCount: c.posts.length,
    topCaptions: c.posts
      .sort((a, b) => (b.likesCount + b.commentsCount) - (a.likesCount + a.commentsCount))
      .slice(0, 5)
      .map(p => ({
        caption: p.caption?.substring(0, 300),
        likes: p.likesCount,
        comments: p.commentsCount,
        username: p.ownerUsername,
      })),
  }));

  const influencerSummary = influencers.slice(0, 10).map(i => ({
    username: i.username,
    followers: i.followers,
    bio: i.bio?.substring(0, 150),
    avgEngagement: i.engagement,
  }));

  const prompt = `You are a social media researcher for VākJournal, a voice-first journaling app.

**About VākJournal:**
- Voice-first journaling app for founders, creators, and leaders
- Users speak their thoughts, AI transforms them into structured insights
- Target audience: Founders, executives, creative professionals
- Key value props: Think out loud, mental clarity, personal growth, reflection

**Your task:** Analyze this Instagram research data and provide actionable insights.

## Trending Content by Hashtag:
${JSON.stringify(contentSummary, null, 2)}

## Potential Influencers (10K-25K followers):
${JSON.stringify(influencerSummary, null, 2)}

Respond with this exact JSON structure:
{
  "trendingSummary": "2-3 sentence summary of current trends in journaling/personal growth content on Instagram",
  "contentIdeas": [
    "5 specific Instagram content ideas for VākJournal based on what's trending - be specific about format (Reel, Carousel, Story) and hook"
  ],
  "keyThemes": [
    "5 themes/topics resonating with the journaling audience right now"
  ],
  "influencerAnalysis": [
    {
      "username": "exact_username",
      "relevanceScore": 8,
      "reason": "Specific reason why they'd be a good VākJournal partner based on their bio/content"
    }
  ],
  "actionItems": [
    "5 specific actions to take this week - be concrete and actionable"
  ]
}

Be specific and actionable. Focus on insights that help VākJournal grow.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2500,
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
      (a: any) => a.username?.toLowerCase() === inf.username?.toLowerCase()
    );
    return {
      ...inf,
      relevanceScore: aiAnalysis?.relevanceScore || 5,
      reason: aiAnalysis?.reason || 'Active in journaling/productivity niche',
    };
  }).sort((a, b) => b.relevanceScore - a.relevanceScore);

  return {
    trendingSummary: analysis.trendingSummary || 'No trends identified.',
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

function formatSlackReport(insights: ResearchInsights, hashtagsSearched: string[]): SlackBlock[] {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  return [
    blocks.header('📸 Instagram Research Report'),
    blocks.context([`VākJournal | ${today} | Hashtags: ${hashtagsSearched.map(h => `#${h}`).join(', ')}`]),
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
    blocks.section('*💡 Content Ideas*'),
    blocks.section(insights.contentIdeas.map((idea, i) => `*${i + 1}.* ${idea}`).join('\n\n')),
    blocks.divider(),

    // Influencers
    blocks.section('*🤝 Influencers to Reach Out*'),
    blocks.section(
      insights.influencersToReach.length > 0
        ? insights.influencersToReach.map(inf =>
            `*<${inf.profileUrl}|@${inf.username}>* · ${(inf.followers / 1000).toFixed(1)}K followers\n` +
            `${'⭐'.repeat(Math.min(Math.round(inf.relevanceScore / 2), 5))} ${inf.reason}`
          ).join('\n\n')
        : '_No influencers found in 10K-25K range_'
    ),
    blocks.divider(),

    // Action Items
    blocks.section('*✅ Action Items*'),
    blocks.section(insights.actionItems.map(item => `• ${item}`).join('\n')),
    blocks.divider(),

    blocks.context(['🤖 VākJournal Instagram Research Agent']),
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

    const apify = new ApifyClient();
    const hashtags = (process.env.HASHTAGS || 'journaling,bulletjournal,voicenotes,morningpages,journalprompts').split(',');

    // Step 1: Search hashtags
    console.log(`Searching hashtags: ${hashtags.join(', ')}`);
    const trendingContent = await apify.searchHashtags(hashtags, 15);

    if (trendingContent.length === 0) {
      throw new Error('No content fetched from hashtags');
    }

    // Step 2: Discover influencers
    console.log('Discovering influencers...');
    const influencers = await apify.discoverInfluencers(trendingContent);
    console.log(`Found ${influencers.length} influencers in 10K-25K range`);

    // Step 3: AI analysis
    console.log('Analyzing with Claude...');
    const insights = await analyzeWithClaude(trendingContent, influencers);

    // Step 4: Send to Slack
    console.log('Sending to Slack...');
    const slackBlocks = formatSlackReport(insights, hashtags);
    await sendToSlack(slackBlocks);

    console.log('Research complete!');
    return res.status(200).json({
      success: true,
      message: 'Research report sent to Slack',
      stats: {
        hashtagsSearched: hashtags.length,
        postsAnalyzed: trendingContent.reduce((sum, c) => sum + c.posts.length, 0),
        influencersFound: influencers.length,
      },
    });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
