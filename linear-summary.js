#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { fetchLinearActivity, formatLinearData } = require('./linear-utils');

const SCRIPT_DIR = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'config.json'), 'utf8'));

// Parse args
let dryRun = false;
let lookbackHours = 24;

for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run') dryRun = true;
  if (arg.startsWith('--hours=')) lookbackHours = parseInt(arg.split('=')[1], 10);
}

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// --- Gemini Flash via OpenRouter: pre-process raw Linear data (optional) ---

async function preprocessWithGemini(openrouterApiKey, formattedData, authorMap) {
  const authorMapStr = Object.entries(authorMap).map(([k, v]) => `${k} → ${v}`).join(', ');

  const prompt = `You are a data organizer. Process this raw Linear ticket activity data into a structured summary.

Author mapping: ${authorMapStr}

${formattedData}

TASK: Organize this data into a concise structured format grouped by ticket:
1. For each ticket: identifier, title, assignee (use display names from mapping), current status.
2. If the ticket has comments/discussions, summarize the key points or decisions in 1-2 sentences. This is the most valuable part — discussions are easy to miss in Linear.
3. Quote specific decisions or action items from comments if present.
4. Separate new tickets (just created) from updated existing tickets.
5. Note any status changes (e.g. moved from Todo to In Progress).
6. Identify main themes or patterns across all ticket activity.

Output ONLY the structured data — no commentary, no formatting instructions. Keep it concise but preserve discussion details. Use plain text, not markdown.`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openrouterApiKey}`,
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter error: ${res.status} — ${body}`);
  }

  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || '';
}

// --- Final LLM: Slack message ---

function generateSlackSummary(structuredData, isPreprocessed) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const llmCommand = CONFIG.llmCommand || 'claude -p -';
  const linearOrg = CONFIG.linearOrg || 'your-org';
  const dataLabel = isPreprocessed ? 'ORGANIZED LINEAR DATA' : 'RAW LINEAR DATA';

  const prompt = `You are a Linear ticket activity summarizer. Generate a concise Slack summary from this ${isPreprocessed ? 'pre-organized' : 'raw'} Linear data.

Date: ${today}

${dataLabel}:
${structuredData}

FORMAT RULES:
- Use Slack mrkdwn (*bold*, _italic_, \`code\`)
- For links use Slack format: <URL|display text>
- Start with: *Linear Activity — ${today}*
- Group by ticket (not by person — Linear is ticket-centric)
- For each ticket line, format as: <linear_url|IDENTIFIER> — Title — *Assignee* \`Status\`
  - Assignee must be *bold* so it's immediately visible
  - Status must be in \`inline code\` (e.g. \`Todo\`, \`In Progress\`, \`Done\`) so it stands out visually
- Link ticket identifiers to Linear: <https://linear.app/${linearOrg}/issue/IDENTIFIER|IDENTIFIER>
- Emphasize *comments and discussions* — these are the most valuable part (easy to miss in Linear)
- Quote key discussion points or decisions from comments (keep brief)
- Add a *Highlights:* section at the end — 1-2 sentences on the main themes or important discussions
- Omit sections that would be empty
- Output ONLY the Slack message — no code blocks, no explanation, no prefix/suffix`;

  try {
    return execSync(llmCommand, {
      input: prompt,
      encoding: 'utf8',
      timeout: 120000,
    }).trim();
  } catch (e) {
    throw new Error(`LLM failed (${llmCommand}): ${e.message}`);
  }
}

// --- Main ---

async function main() {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    log('ERROR: LINEAR_API_KEY not set');
    process.exit(1);
  }

  const teamId = CONFIG.linearTeamId;
  if (!teamId) {
    log('ERROR: linearTeamId not set in config.json');
    process.exit(1);
  }

  const webhookUrl = CONFIG.linearSlackWebhookUrl;
  if (!dryRun && !webhookUrl) {
    log('ERROR: linearSlackWebhookUrl not set in config.json');
    process.exit(1);
  }

  // Step 1: Collect raw Linear data
  log(`Fetching Linear activity for last ${lookbackHours}h...`);
  const data = await fetchLinearActivity(apiKey, teamId, lookbackHours);

  const totalIssues = data.newIssues.length + data.activeIssues.length;
  const totalComments = data.recentComments.length;
  log(`Found ${data.newIssues.length} new issues, ${data.activeIssues.length} updated issues, ${totalComments} comments`);

  if (totalIssues === 0 && totalComments === 0) {
    log('No Linear activity found. Skipping summary.');
    process.exit(0);
  }

  const authorMap = CONFIG.linearAuthorMap || {};
  const formattedData = formatLinearData(data, authorMap);

  // Step 2: Gemini Flash pre-processing (optional)
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  let structuredData = formattedData;
  let isPreprocessed = false;

  if (openrouterApiKey) {
    log('Running Gemini Flash pre-processing...');
    try {
      const result = await preprocessWithGemini(openrouterApiKey, formattedData, authorMap);
      if (result) {
        structuredData = result;
        isPreprocessed = true;
      } else {
        log('Gemini returned empty result, using raw data...');
      }
    } catch (e) {
      log(`Gemini pre-processing failed: ${e.message}`);
      log('Falling back to raw data...');
    }
  } else {
    log('No OPENROUTER_API_KEY — skipping Gemini pre-processing...');
  }

  // Step 3: Final LLM — polished Slack message
  const llmCommand = CONFIG.llmCommand || 'claude -p -';
  log(`Running LLM summary (${llmCommand})...`);
  const summary = generateSlackSummary(structuredData, isPreprocessed);

  if (!summary) {
    log('ERROR: Empty summary from LLM');
    process.exit(1);
  }

  if (dryRun) {
    log('DRY RUN — would post to Slack:');
    console.log('---');
    console.log(summary);
    console.log('---');
    console.log('');
    if (isPreprocessed) {
      console.log('Gemini structured data:');
      console.log(structuredData);
      console.log('');
    }
    console.log('Raw Linear data:');
    console.log(formattedData);
    process.exit(0);
  }

  // Post to Slack
  const payload = JSON.stringify({ text: summary });
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });

  if (res.ok) {
    log('Posted to Slack successfully');
  } else {
    log(`ERROR: Slack returned HTTP ${res.status}`);
    process.exit(1);
  }
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  process.exit(1);
});
