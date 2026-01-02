import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';

// ============ Types ============

interface ApifyProfile {
  username: string;
  fullName?: string;
  biography?: string;
  followersCount: number;
  followsCount: number;
  postsCount: number;
  isVerified: boolean;
  externalUrl?: string;
  profilePicUrl?: string;
}

interface ApifyPost {
  id: string;
  shortCode: string;
  caption?: string;
  url: string;
  likesCount: number;
  commentsCount: number;
  ownerUsername: string;
}

interface ApifyComment {
  text: string;
  ownerUsername: string;
  ownerProfilePicUrl?: string;
  likesCount: number;
}

// ============ Apify Client ============

class ApifyClient {
  private apiToken: string;
  private baseUrl = 'https://api.apify.com/v2';

  constructor() {
    this.apiToken = process.env.APIFY_API_TOKEN!;
  }

  private async runActor<T>(actorId: string, input: Record<string, any>): Promise<T[]> {
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

    // Wait for completion
    let status = runData.data.status;
    let attempts = 0;
    while (status !== 'SUCCEEDED' && status !== 'FAILED' && attempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const statusResponse = await fetch(
        `${this.baseUrl}/actor-runs/${runId}?token=${this.apiToken}`
      );
      const statusData = await statusResponse.json();
      status = statusData.data.status;
      attempts++;
    }

    if (status !== 'SUCCEEDED') {
      throw new Error(`Apify run failed: ${status}`);
    }

    const datasetId = runData.data.defaultDatasetId;
    const resultsResponse = await fetch(
      `${this.baseUrl}/datasets/${datasetId}/items?token=${this.apiToken}`
    );

    return resultsResponse.json();
  }

  async searchProfilesByKeyword(keywords: string[], limit: number = 20): Promise<ApifyProfile[]> {
    // Use Instagram Search Scraper to find profiles by bio keywords
    try {
      const results = await this.runActor<ApifyProfile>('apify~instagram-scraper', {
        search: keywords.join(' '),
        searchType: 'user',
        resultsLimit: limit,
      });
      return results;
    } catch (error) {
      console.error('Error searching profiles:', error);
      return [];
    }
  }

  async getPostCommenters(hashtag: string, limit: number = 50): Promise<string[]> {
    // Get posts from hashtag, then extract commenters
    try {
      const posts = await this.runActor<ApifyPost>('apify~instagram-hashtag-scraper', {
        hashtags: [hashtag],
        resultsLimit: 10,
      });

      // Get unique usernames from post owners (people posting about journaling)
      const usernames = new Set<string>();
      posts.forEach(post => {
        if (post.ownerUsername) usernames.add(post.ownerUsername);
      });

      return Array.from(usernames).slice(0, limit);
    } catch (error) {
      console.error('Error getting commenters:', error);
      return [];
    }
  }

  async getProfileDetails(usernames: string[]): Promise<ApifyProfile[]> {
    if (usernames.length === 0) return [];
    try {
      const profiles = await this.runActor<ApifyProfile>('apify~instagram-profile-scraper', {
        usernames: usernames.slice(0, 30),
      });
      return profiles;
    } catch (error) {
      console.error('Error getting profiles:', error);
      return [];
    }
  }

  async searchByBio(bioKeywords: string[], limit: number = 30): Promise<ApifyProfile[]> {
    // Search for profiles and filter by bio content
    try {
      // First get profiles from hashtag content creators
      const hashtagResults = await this.runActor<ApifyPost>('apify~instagram-hashtag-scraper', {
        hashtags: ['journaling', 'personalgrowth', 'mindfulness'],
        resultsLimit: 50,
      });

      const usernames = [...new Set(hashtagResults.map(p => p.ownerUsername))];
      const profiles = await this.getProfileDetails(usernames);

      // Filter by bio keywords
      const filteredProfiles = profiles.filter(p => {
        const bio = (p.biography || '').toLowerCase();
        return bioKeywords.some(kw => bio.includes(kw.toLowerCase()));
      });

      return filteredProfiles.slice(0, limit);
    } catch (error) {
      console.error('Error searching by bio:', error);
      return [];
    }
  }
}

// ============ Tool Definitions ============

const tools: Anthropic.Tool[] = [
  {
    name: 'search_by_bio_keywords',
    description: 'Search for Instagram accounts whose bio contains specific keywords. Good for finding people who identify as founders, coaches, writers, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords to search for in user bios (e.g., ["founder", "coach", "writer", "journal"])'
        },
        limit: {
          type: 'number',
          description: 'Max number of profiles to return (default 20)'
        }
      },
      required: ['keywords']
    }
  },
  {
    name: 'find_content_creators',
    description: 'Find accounts actively creating content about a topic by searching who posts with related hashtags',
    input_schema: {
      type: 'object' as const,
      properties: {
        hashtag: {
          type: 'string',
          description: 'Hashtag to search (without #). E.g., "morningpages", "voicenotes", "dailyjournal"'
        },
        limit: {
          type: 'number',
          description: 'Max number of creators to find (default 30)'
        }
      },
      required: ['hashtag']
    }
  },
  {
    name: 'get_profile_details',
    description: 'Get detailed information about specific Instagram accounts including bio, follower count, and recent post themes',
    input_schema: {
      type: 'object' as const,
      properties: {
        usernames: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of Instagram usernames to look up'
        }
      },
      required: ['usernames']
    }
  },
  {
    name: 'report_findings',
    description: 'Submit the final research findings. Call this when you have gathered enough accounts and insights.',
    input_schema: {
      type: 'object' as const,
      properties: {
        influencers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              username: { type: 'string' },
              followers: { type: 'number' },
              bio: { type: 'string' },
              reason: { type: 'string', description: 'Why this person is a good fit for VākJournal' },
              outreach_angle: { type: 'string', description: 'Suggested angle for reaching out' }
            }
          },
          description: 'List of recommended influencers/accounts to reach out to'
        },
        content_insights: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key insights about what content resonates in this niche'
        },
        suggested_comments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              username: { type: 'string' },
              context: { type: 'string' },
              comment: { type: 'string' }
            }
          },
          description: 'Suggested thoughtful comments to post on their content'
        },
        action_items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific actions to take this week'
        }
      },
      required: ['influencers', 'content_insights', 'action_items']
    }
  }
];

// ============ Tool Execution ============

async function executeTool(apify: ApifyClient, name: string, input: any): Promise<string> {
  console.log(`Executing tool: ${name}`, input);

  switch (name) {
    case 'search_by_bio_keywords': {
      const profiles = await apify.searchByBio(input.keywords, input.limit || 20);
      return JSON.stringify({
        found: profiles.length,
        profiles: profiles.map(p => ({
          username: p.username,
          fullName: p.fullName,
          bio: p.biography?.substring(0, 200),
          followers: p.followersCount,
          posts: p.postsCount,
          verified: p.isVerified,
          website: p.externalUrl,
        }))
      }, null, 2);
    }

    case 'find_content_creators': {
      const usernames = await apify.getPostCommenters(input.hashtag, input.limit || 30);
      const profiles = await apify.getProfileDetails(usernames);
      return JSON.stringify({
        hashtag: input.hashtag,
        found: profiles.length,
        creators: profiles.map(p => ({
          username: p.username,
          fullName: p.fullName,
          bio: p.biography?.substring(0, 200),
          followers: p.followersCount,
          posts: p.postsCount,
        }))
      }, null, 2);
    }

    case 'get_profile_details': {
      const profiles = await apify.getProfileDetails(input.usernames);
      return JSON.stringify({
        profiles: profiles.map(p => ({
          username: p.username,
          fullName: p.fullName,
          bio: p.biography,
          followers: p.followersCount,
          following: p.followsCount,
          posts: p.postsCount,
          verified: p.isVerified,
          website: p.externalUrl,
        }))
      }, null, 2);
    }

    case 'report_findings': {
      // This is the final output - return as-is
      return JSON.stringify(input);
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ============ Agent Loop ============

async function runAgent(apify: ApifyClient): Promise<any> {
  const anthropic = new Anthropic();

  const systemPrompt = `You are an Instagram research agent for VākJournal, a voice-first journaling app.

**About VākJournal:**
- Voice-first journaling app for founders, creators, and leaders
- Users speak their thoughts, AI transforms them into structured insights
- Target audience: Founders, executives, creative professionals, coaches
- Key themes: Think out loud, mental clarity, personal growth, reflection, voice notes

**Your mission:**
Find Instagram accounts that would be great partners, collaborators, or audiences for VākJournal.

**Research strategy:**
1. Search for people with relevant bio keywords (founder, coach, writer, journal, mindset, growth)
2. Find content creators posting about journaling, voice notes, personal growth, morning routines
3. Look for accounts in the 5K-100K follower range (accessible but influential)
4. Identify accounts that engage their audience with reflective content

**Output requirements:**
- Find 10-15 relevant accounts with outreach angles
- Provide 3-5 content insights
- Suggest thoughtful comments for engagement
- Give specific action items

Use the tools available to research, then call report_findings with your complete analysis.`;

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Research Instagram accounts for VākJournal partnership and engagement opportunities.

Focus on:
1. Bio keyword search: Look for founders, coaches, writers, journaling enthusiasts
2. Content creators: Find people posting about voice notes, morning pages, reflection, personal growth
3. Target follower range: 5K-100K (sweet spot for engagement)

Find at least 10 quality accounts and provide actionable insights. Use your tools strategically.`
    }
  ];

  let finalReport: any = null;
  let iterations = 0;
  const maxIterations = 10;

  while (!finalReport && iterations < maxIterations) {
    iterations++;
    console.log(`\n--- Agent iteration ${iterations} ---`);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: systemPrompt,
      tools,
      messages,
    });

    // Check if we need to execute tools
    if (response.stop_reason === 'tool_use') {
      const assistantMessage: Anthropic.MessageParam = {
        role: 'assistant',
        content: response.content,
      };
      messages.push(assistantMessage);

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`Tool call: ${block.name}`);

          if (block.name === 'report_findings') {
            // Final report - we're done
            finalReport = block.input;
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'Report submitted successfully.',
            });
          } else {
            // Execute the tool
            const result = await executeTool(apify, block.name, block.input);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result,
            });
          }
        }
      }

      messages.push({
        role: 'user',
        content: toolResults,
      });
    } else {
      // Agent finished without calling report_findings
      console.log('Agent finished without final report');
      break;
    }
  }

  return finalReport;
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

function formatSlackReport(report: any): SlackBlock[] {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const slackBlocks: SlackBlock[] = [
    blocks.header('🤖 Instagram Research Agent Report'),
    blocks.context([`VākJournal | ${today} | AI Agent Research`]),
    blocks.divider(),
  ];

  // Influencers
  if (report.influencers?.length > 0) {
    slackBlocks.push(blocks.section('*🤝 Accounts to Reach Out To*'));
    const influencerText = report.influencers.map((inf: any) =>
      `*<https://instagram.com/${inf.username}|@${inf.username}>*` +
      (inf.followers ? ` · ${(inf.followers / 1000).toFixed(1)}K followers` : '') +
      (inf.bio ? `\n_${inf.bio.substring(0, 100)}..._` : '') +
      `\n✨ *Why:* ${inf.reason}` +
      (inf.outreach_angle ? `\n📧 *Angle:* ${inf.outreach_angle}` : '')
    ).join('\n\n');
    slackBlocks.push(blocks.section(influencerText));
    slackBlocks.push(blocks.divider());
  }

  // Suggested Comments
  if (report.suggested_comments?.length > 0) {
    slackBlocks.push(blocks.section('*💬 Posts to Engage With*'));
    const commentsText = report.suggested_comments.map((c: any) =>
      `*@${c.username}*` +
      (c.context ? `\n_Context: ${c.context}_` : '') +
      `\n➡️ "${c.comment}"`
    ).join('\n\n');
    slackBlocks.push(blocks.section(commentsText));
    slackBlocks.push(blocks.divider());
  }

  // Content Insights
  if (report.content_insights?.length > 0) {
    slackBlocks.push(blocks.section('*💡 Content Insights*'));
    slackBlocks.push(blocks.section(report.content_insights.map((i: string, idx: number) =>
      `${idx + 1}. ${i}`
    ).join('\n')));
    slackBlocks.push(blocks.divider());
  }

  // Action Items
  if (report.action_items?.length > 0) {
    slackBlocks.push(blocks.section('*✅ Action Items*'));
    slackBlocks.push(blocks.section(report.action_items.map((a: string) => `• ${a}`).join('\n')));
    slackBlocks.push(blocks.divider());
  }

  slackBlocks.push(blocks.context(['🤖 Generated by VākJournal Instagram Research Agent (Claude + Apify)']));

  return slackBlocks;
}

async function sendToSlack(slackBlocks: SlackBlock[]): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL!;
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks: slackBlocks, text: 'Instagram Research Agent Report' }),
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
    console.log('Starting Instagram Research Agent...');

    const apify = new ApifyClient();
    const report = await runAgent(apify);

    if (!report) {
      throw new Error('Agent did not produce a final report');
    }

    console.log('Agent completed. Sending to Slack...');
    const slackBlocks = formatSlackReport(report);
    await sendToSlack(slackBlocks);

    console.log('Done!');
    return res.status(200).json({
      success: true,
      message: 'Agent research report sent to Slack',
      stats: {
        influencersFound: report.influencers?.length || 0,
        insightsGenerated: report.content_insights?.length || 0,
      },
    });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
