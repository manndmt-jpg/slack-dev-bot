const { App } = require('@slack/bolt');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'config.json'), 'utf8'));
const CONTEXT = fs.existsSync(path.join(SCRIPT_DIR, 'context.md'))
  ? fs.readFileSync(path.join(SCRIPT_DIR, 'context.md'), 'utf8')
  : '';

// Optional Linear support
let linearUtils = null;
try {
  linearUtils = require('./linear-utils');
} catch (e) {
  // linear-utils.js not present — Linear features disabled
}

const app = new App({
  token: CONFIG.slackBotToken,
  appToken: CONFIG.slackAppToken,
  socketMode: true,
});

// Store last data for context in follow-up questions
let lastSummary = '';
let lastRawData = '';
let lastLinearData = '';

// Collect recent GitHub data by running git-summary.js --dry-run
function collectRecentData(hours = 24) {
  try {
    const result = execSync(
      `node ${path.join(SCRIPT_DIR, 'git-summary.js')} --dry-run --hours=${hours} 2>/dev/null`,
      { encoding: 'utf8', timeout: 120000 }
    );
    // Extract summary and raw data sections from dry-run output
    const summaryStart = result.indexOf('---\n');
    const summaryEnd = result.indexOf('\n---', summaryStart + 4);
    const rawStart = result.indexOf('Raw:');

    if (summaryStart !== -1 && summaryEnd !== -1) {
      lastSummary = result.substring(summaryStart + 4, summaryEnd).trim();
    }
    if (rawStart !== -1) {
      lastRawData = result.substring(rawStart).trim();
    }
    return { summary: lastSummary, rawData: lastRawData };
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Data collection error:`, e.message);
    return { summary: lastSummary, rawData: lastRawData };
  }
}

// Collect recent Linear data (optional)
async function collectLinearData(hours = 24) {
  if (!linearUtils) return lastLinearData;

  const apiKey = process.env.LINEAR_API_KEY;
  const teamId = CONFIG.linearTeamId;
  if (!apiKey || !teamId) {
    return lastLinearData;
  }
  try {
    const data = await linearUtils.fetchLinearActivity(apiKey, teamId, hours);
    const authorMap = CONFIG.linearAuthorMap || {};
    lastLinearData = linearUtils.formatLinearData(data, authorMap);
    return lastLinearData;
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Linear data collection error:`, e.message);
    return lastLinearData;
  }
}

// Run LLM with a prompt (pipes via stdin)
const LLM_CMD = CONFIG.llmCommand || 'claude -p -';

function askLLM(prompt) {
  try {
    const result = execSync(LLM_CMD, {
      input: prompt,
      encoding: 'utf8',
      timeout: 120000,
    });
    return result.trim();
  } catch (e) {
    console.error(`[${new Date().toISOString()}] LLM error:`, e.message);
    return null;
  }
}

// Handle @mentions
app.event('app_mention', async ({ event, say }) => {
  const question = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!question) {
    await say({ text: 'What would you like to know about the team\'s dev activity?', thread_ts: event.ts });
    return;
  }

  console.log(`[${new Date().toISOString()}] Question from <@${event.user}>: ${question}`);

  // React with eyes to show we're working on it
  try {
    await app.client.reactions.add({
      token: CONFIG.slackBotToken,
      channel: event.channel,
      name: 'eyes',
      timestamp: event.ts,
    });
  } catch (e) {
    // Ignore reaction errors
  }

  // Collect fresh data if we don't have any
  if (!lastRawData) {
    collectRecentData(24);
  }
  if (!lastLinearData && linearUtils) {
    await collectLinearData(24);
  }

  // Build author mapping strings
  const gitAuthorLines = CONFIG.authorMap
    ? Object.entries(CONFIG.authorMap).map(([k, v]) => `  ${k} → ${v}`).join('\n')
    : '';
  const linearAuthorLines = CONFIG.linearAuthorMap
    ? Object.entries(CONFIG.linearAuthorMap).map(([k, v]) => `  ${k} → ${v}`).join('\n')
    : '';

  const linearOrg = CONFIG.linearOrg || 'your-org';

  const prompt = `You are a dev team assistant in a Slack channel. Answer the following question about the team's recent development activity.

PROJECT CONTEXT:
${CONTEXT}

GitHub author mapping:
${gitAuthorLines}
${linearAuthorLines ? `\nLinear author mapping:\n${linearAuthorLines}` : ''}

LAST DAILY SUMMARY:
${lastSummary || '(no summary available yet)'}

RAW COMMIT/PR DATA (last 24h):
${lastRawData || '(no data available yet)'}

LINEAR TICKET ACTIVITY (last 24h):
${lastLinearData || '(no Linear data available)'}

USER QUESTION: ${question}

RULES:
- Answer concisely using Slack mrkdwn formatting
- Use display names (not GitHub usernames) when referring to team members
- You have both GitHub (commits, PRs) and Linear (tickets, comments) data — use whichever is relevant
${lastLinearData ? `- Link Linear tickets as: <https://linear.app/${linearOrg}/issue/IDENTIFIER|IDENTIFIER>` : ''}
- If you don't have enough data to answer, say so
- Do NOT wrap output in code blocks`;

  const answer = askLLM(prompt);

  // Remove eyes reaction
  try {
    await app.client.reactions.remove({
      token: CONFIG.slackBotToken,
      channel: event.channel,
      name: 'eyes',
      timestamp: event.ts,
    });
  } catch (e) {
    // Ignore
  }

  if (answer) {
    await say({ text: answer, thread_ts: event.ts });
  } else {
    await say({ text: 'Sorry, I couldn\'t generate a response. Try again in a moment.', thread_ts: event.ts });
  }
});

// On startup, collect initial data
(async () => {
  await app.start();
  console.log(`[${new Date().toISOString()}] Bot is running (Socket Mode)`);

  collectRecentData(24);
  console.log(`[${new Date().toISOString()}] Initial git data loaded`);

  if (linearUtils && process.env.LINEAR_API_KEY && CONFIG.linearTeamId) {
    await collectLinearData(24);
    console.log(`[${new Date().toISOString()}] Initial Linear data loaded`);
  }
})();
