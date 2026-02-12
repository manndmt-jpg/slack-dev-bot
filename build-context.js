#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'config.json'), 'utf8'));
const CONTEXT_PATH = path.join(SCRIPT_DIR, 'context.md');
const MARKER = '<!-- AUTO-GENERATED BELOW — DO NOT EDIT MANUALLY -->';

// Parse args
let dryRun = false;
for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run') dryRun = true;
}

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// --- Linear: fetch active tickets ---
async function fetchActiveTickets(apiKey, teamId) {
  const query = `
    query($teamId: String!) {
      team(id: $teamId) {
        issues(
          filter: {
            state: { name: { in: ["In Progress", "Todo", "In Review"] } }
          }
          first: 100
          orderBy: updatedAt
        ) {
          nodes {
            identifier
            title
            state { name }
            assignee { displayName }
          }
        }
      }
    }
  `;

  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
    },
    body: JSON.stringify({ query, variables: { teamId } }),
  });

  if (!res.ok) throw new Error(`Linear API error: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Linear GraphQL errors: ${JSON.stringify(json.errors)}`);

  return json.data.team.issues.nodes;
}

function formatTickets(issues, authorMap) {
  const mapName = (name) => {
    if (!name) return 'Unassigned';
    for (const [key, val] of Object.entries(authorMap)) {
      if (name.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(name.toLowerCase())) {
        return val;
      }
    }
    return name;
  };

  return issues.map((i) =>
    `- ${i.identifier}: ${i.title} — ${i.state.name} — ${mapName(i.assignee?.displayName)}`
  ).join('\n');
}

// --- Notion: fetch recently edited specs ---
async function fetchNotionSpecs(notionApiKey, databaseId, daysBack = 7) {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${notionApiKey}`,
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      filter: {
        property: 'Last edited time',
        last_edited_time: { on_or_after: since },
      },
      page_size: 10,
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion API error: ${res.status} — ${body}`);
  }

  const json = await res.json();
  return json.results;
}

async function fetchPageBlocks(notionApiKey, pageId) {
  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
    headers: {
      'Authorization': `Bearer ${notionApiKey}`,
      'Notion-Version': '2022-06-28',
    },
  });

  if (!res.ok) return [];
  const json = await res.json();

  const textParts = [];
  for (const block of json.results) {
    const richTexts = block[block.type]?.rich_text;
    if (richTexts) {
      const text = richTexts.map((t) => t.plain_text).join('');
      if (text) textParts.push(text);
    }
  }
  return textParts;
}

function getPageTitle(page) {
  for (const key of Object.keys(page.properties)) {
    const prop = page.properties[key];
    if (prop.type === 'title' && prop.title?.length > 0) {
      return prop.title.map((t) => t.plain_text).join('');
    }
  }
  return 'Untitled';
}

// --- Gemini Flash via OpenRouter (optional) ---
async function summarizeWithGemini(openrouterApiKey, title, content) {
  const prompt = `Summarize this product spec in 3-5 bullet points: what it does, current status, and key decisions made. Be concise.\n\nTitle: ${title}\n\nContent:\n${content.slice(0, 8000)}`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openrouterApiKey}`,
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter error: ${res.status} — ${body}`);
  }

  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || '';
}

// --- Main ---
async function main() {
  const linearApiKey = process.env.LINEAR_API_KEY;
  const notionApiKey = process.env.NOTION_API_KEY;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  const teamId = CONFIG.linearTeamId;
  const databaseId = CONFIG.notionDatabaseId;

  // Read existing context.md
  let existingContent = '';
  if (fs.existsSync(CONTEXT_PATH)) {
    existingContent = fs.readFileSync(CONTEXT_PATH, 'utf8');
  }

  // Split at marker — keep static section
  const markerIdx = existingContent.indexOf(MARKER);
  const staticSection = markerIdx !== -1
    ? existingContent.slice(0, markerIdx).trimEnd()
    : existingContent.trimEnd();

  const generatedParts = [];
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  generatedParts.push(`_Last updated: ${timestamp}_\n`);

  // Step A: Linear active tickets (optional)
  if (linearApiKey && teamId) {
    log('Fetching active Linear tickets...');
    try {
      const issues = await fetchActiveTickets(linearApiKey, teamId);
      const authorMap = CONFIG.linearAuthorMap || {};
      const formatted = formatTickets(issues, authorMap);
      log(`Found ${issues.length} active tickets`);
      generatedParts.push(`## Active Tickets (Linear)\n\n${formatted}\n`);
    } catch (e) {
      log(`Linear error (non-fatal): ${e.message}`);
      generatedParts.push(`## Active Tickets (Linear)\n\n_Failed to fetch: ${e.message}_\n`);
    }
  } else {
    log('Skipping Linear (no LINEAR_API_KEY or linearTeamId)');
  }

  // Step B: Notion specs (optional — requires Notion + OpenRouter)
  if (notionApiKey && databaseId) {
    log('Fetching recent Notion specs...');
    try {
      const pages = await fetchNotionSpecs(notionApiKey, databaseId);
      log(`Found ${pages.length} recently edited specs`);

      if (pages.length > 0) {
        const specSummaries = [];

        for (const page of pages) {
          const title = getPageTitle(page);
          log(`  Summarizing: ${title}`);

          try {
            const blocks = await fetchPageBlocks(notionApiKey, page.id);
            const content = blocks.join('\n\n');

            if (content.length < 50) {
              specSummaries.push(`### ${title}\n\n_Page has minimal content._`);
              continue;
            }

            if (openrouterApiKey) {
              const summary = await summarizeWithGemini(openrouterApiKey, title, content);
              specSummaries.push(`### ${title}\n\n${summary}`);
            } else {
              // No Gemini — use raw text excerpt
              const excerpt = content.slice(0, 300).replace(/\n/g, ' ');
              specSummaries.push(`### ${title}\n\n${excerpt}...`);
            }
          } catch (e) {
            log(`  Error for "${title}" (non-fatal): ${e.message}`);
            const blocks = await fetchPageBlocks(notionApiKey, page.id).catch(() => []);
            const fallback = blocks.join(' ').slice(0, 200);
            specSummaries.push(`### ${title}\n\n${fallback || '_Could not fetch content._'}`);
          }
        }

        generatedParts.push(`## Recent Specs (Notion)\n\n${specSummaries.join('\n\n')}\n`);
      }
    } catch (e) {
      log(`Notion error (non-fatal): ${e.message}`);
      generatedParts.push(`## Recent Specs (Notion)\n\n_Failed to fetch: ${e.message}_\n`);
    }
  } else {
    log('Skipping Notion (no NOTION_API_KEY or notionDatabaseId)');
  }

  // Assemble final context.md
  const autoSection = generatedParts.join('\n');
  const finalContent = `${staticSection}\n\n${MARKER}\n\n${autoSection}`;

  if (dryRun) {
    log('DRY RUN — would write to context.md:');
    console.log('---');
    console.log(finalContent);
    console.log('---');
    process.exit(0);
  }

  fs.writeFileSync(CONTEXT_PATH, finalContent, 'utf8');
  log(`Updated ${CONTEXT_PATH}`);
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  process.exit(1);
});
