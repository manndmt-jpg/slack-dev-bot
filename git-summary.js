#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

// --- Data collection via gh CLI ---

function gh(args) {
  try {
    return execSync(`gh ${args}`, { encoding: 'utf8', timeout: 30000 }).trim();
  } catch (e) {
    return '';
  }
}

function ghJSON(args) {
  const raw = gh(args);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectGitData() {
  const org = CONFIG.org;
  const extraRepos = CONFIG.extraRepos || [];
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  // Get all repos in org
  const orgRepos = gh(`api "orgs/${org}/repos" --paginate --jq ".[].name"`)
    .split('\n')
    .filter(Boolean)
    .map((r) => `${org}/${r}`);

  const allRepos = [...orgRepos, ...extraRepos];
  log(`Found ${allRepos.length} repos to scan`);

  const data = {
    commits: [],
    prs: [],
    reviews: [],
    comments: [],
    issues: [],
    releases: [],
    branchEvents: [],
    memberEvents: [],
  };
  const seenSHAs = new Set();

  for (const fullRepo of allRepos) {
    const repoName = fullRepo.split('/').pop();
    log(`Scanning ${fullRepo}...`);

    // Get branches
    const branches = gh(`api "repos/${fullRepo}/branches" --paginate --jq ".[].name"`)
      .split('\n')
      .filter(Boolean);

    if (branches.length === 0) {
      log(`  No branches in ${fullRepo}, skipping`);
      continue;
    }

    // 1. Commits from all branches, deduplicated by SHA
    for (const branch of branches) {
      const raw = gh(`api "repos/${fullRepo}/commits?since=${since}&sha=${branch}&per_page=100" --jq '.[] | [.sha, (.author.login // .commit.author.name // "unknown"), (.commit.message | split("\\n") | .[0])] | @tsv'`);
      if (!raw) continue;

      for (const line of raw.split('\n')) {
        if (!line) continue;
        const [sha, author, ...msgParts] = line.split('\t');
        const message = msgParts.join('\t');
        if (!sha || seenSHAs.has(sha)) continue;
        seenSHAs.add(sha);
        data.commits.push({
          repo: repoName,
          fullRepo,
          author,
          branch,
          message,
          url: `https://github.com/${fullRepo}/commit/${sha}`,
        });
      }
    }

    // 2. PRs with reviews (created, merged, or closed in window)
    // Don't use updatedAt — bots (CI, Vercel, etc.) bump it constantly
    const prs = ghJSON(`pr list --repo "${fullRepo}" --state all --json number,title,author,state,createdAt,mergedAt,closedAt,reviews --limit 50`);
    if (prs) {
      for (const pr of prs) {
        const inWindow = pr.createdAt >= since
          || (pr.mergedAt && pr.mergedAt >= since)
          || (pr.closedAt && pr.closedAt >= since);
        if (!inWindow) continue;

        data.prs.push({
          repo: repoName,
          fullRepo,
          number: pr.number,
          title: pr.title,
          author: pr.author?.login || 'unknown',
          state: pr.state,
          createdAt: pr.createdAt?.slice(0, 10) || '',
          mergedAt: pr.mergedAt?.slice(0, 10) || '',
          closedAt: pr.closedAt?.slice(0, 10) || '',
          url: `https://github.com/${fullRepo}/pull/${pr.number}`,
        });

        // Extract reviews submitted in the time window
        for (const review of (pr.reviews || [])) {
          if (review.submittedAt >= since && review.state !== 'PENDING') {
            data.reviews.push({
              repo: repoName,
              prNumber: pr.number,
              prTitle: pr.title,
              reviewer: review.author?.login || 'unknown',
              state: review.state,
            });
          }
        }
      }
    }

    // 3. Issue and PR comments (general discussion comments)
    const commentsRaw = ghJSON(`api "repos/${fullRepo}/issues/comments?since=${since}&per_page=100"`);
    if (commentsRaw) {
      for (const c of commentsRaw) {
        const num = c.issue_url?.match(/\/(\d+)$/)?.[1];
        data.comments.push({
          repo: repoName,
          author: c.user?.login || 'unknown',
          issueNumber: num || '?',
          body: (c.body || '').split('\n')[0].slice(0, 120),
          createdAt: c.created_at,
        });
      }
    }

    // 4. PR review comments (inline code review comments)
    const reviewCommentsRaw = ghJSON(`api "repos/${fullRepo}/pulls/comments?since=${since}&per_page=100"`);
    if (reviewCommentsRaw) {
      for (const c of reviewCommentsRaw) {
        const prNum = c.pull_request_url?.match(/\/(\d+)$/)?.[1];
        data.comments.push({
          repo: repoName,
          author: c.user?.login || 'unknown',
          issueNumber: prNum || '?',
          body: (c.body || '').split('\n')[0].slice(0, 120),
          createdAt: c.created_at,
          isReviewComment: true,
        });
      }
    }

    // 5. Issues (exclude PRs — they have pull_request key)
    const issuesRaw = ghJSON(`api "repos/${fullRepo}/issues?since=${since}&state=all&per_page=100"`);
    if (issuesRaw) {
      for (const issue of issuesRaw) {
        if (issue.pull_request) continue;
        data.issues.push({
          repo: repoName,
          number: issue.number,
          title: issue.title,
          author: issue.user?.login || 'unknown',
          state: issue.state,
          createdAt: issue.created_at?.slice(0, 10) || '',
          url: issue.html_url,
        });
      }
    }

    // 6. Releases
    const releasesRaw = ghJSON(`api "repos/${fullRepo}/releases?per_page=10"`);
    if (releasesRaw) {
      for (const rel of releasesRaw) {
        if (rel.published_at >= since) {
          data.releases.push({
            repo: repoName,
            tag: rel.tag_name,
            name: rel.name || rel.tag_name,
            author: rel.author?.login || 'unknown',
            publishedAt: rel.published_at?.slice(0, 10) || '',
            url: rel.html_url,
          });
        }
      }
    }
  }

  // 7. Org events — branch create/delete and membership changes
  log('Fetching org events...');
  const events = ghJSON(`api "orgs/${org}/events?per_page=100"`);
  if (events) {
    for (const ev of events) {
      if (ev.created_at < since) continue;
      const repoName = ev.repo?.name?.replace(`${org}/`, '') || '';

      if (ev.type === 'CreateEvent' && ev.payload?.ref_type === 'branch') {
        data.branchEvents.push({
          repo: repoName,
          author: ev.actor?.login || 'unknown',
          action: 'created',
          branch: ev.payload.ref,
        });
      } else if (ev.type === 'DeleteEvent' && ev.payload?.ref_type === 'branch') {
        data.branchEvents.push({
          repo: repoName,
          author: ev.actor?.login || 'unknown',
          action: 'deleted',
          branch: ev.payload.ref,
        });
      } else if (ev.type === 'MemberEvent') {
        data.memberEvents.push({
          repo: repoName,
          member: ev.payload?.member?.login || 'unknown',
          action: ev.payload?.action || 'added',
          actor: ev.actor?.login || 'unknown',
        });
      }
    }
  }

  // Deduplicate comments (issues/comments and pulls/comments can overlap)
  const commentKeys = new Set();
  data.comments = data.comments.filter((c) => {
    const key = `${c.repo}:${c.author}:${c.issueNumber}:${c.createdAt}`;
    if (commentKeys.has(key)) return false;
    commentKeys.add(key);
    return true;
  });

  log(`Collected: ${data.commits.length} commits, ${data.prs.length} PRs, ${data.reviews.length} reviews, ${data.comments.length} comments, ${data.issues.length} issues, ${data.releases.length} releases, ${data.branchEvents.length} branch events, ${data.memberEvents.length} membership changes`);

  return data;
}

function formatRawData(data, authorMap) {
  const n = (author) => authorMap[author] || author;
  const lines = [];

  if (data.commits.length > 0) {
    lines.push('COMMITS:');
    for (const c of data.commits) {
      lines.push(`[${c.repo}] ${n(c.author)} (${c.branch}): ${c.message} | ${c.url}`);
    }
  }

  if (data.prs.length > 0) {
    lines.push('\nPULL REQUESTS:');
    for (const pr of data.prs) {
      let status = pr.state;
      if (pr.mergedAt) status = `MERGED ${pr.mergedAt}`;
      else if (pr.closedAt) status = `CLOSED ${pr.closedAt}`;
      lines.push(`[${pr.repo}] [${status}] #${pr.number} ${pr.title} by ${n(pr.author)} | created:${pr.createdAt} | ${pr.url}`);
    }
  }

  if (data.reviews.length > 0) {
    lines.push('\nPR REVIEWS:');
    for (const r of data.reviews) {
      lines.push(`[${r.repo}] PR #${r.prNumber}: ${n(r.reviewer)} → ${r.state}`);
    }
  }

  if (data.comments.length > 0) {
    lines.push('\nCOMMENTS:');
    for (const c of data.comments) {
      const type = c.isReviewComment ? 'code review on' : 'commented on';
      lines.push(`[${c.repo}] ${n(c.author)} ${type} #${c.issueNumber}: ${c.body}`);
    }
  }

  if (data.issues.length > 0) {
    lines.push('\nISSUES:');
    for (const i of data.issues) {
      lines.push(`[${i.repo}] [${i.state}] #${i.number} ${i.title} by ${n(i.author)} | ${i.url}`);
    }
  }

  if (data.releases.length > 0) {
    lines.push('\nRELEASES:');
    for (const r of data.releases) {
      lines.push(`[${r.repo}] ${r.tag} "${r.name}" by ${n(r.author)} | ${r.publishedAt} | ${r.url}`);
    }
  }

  if (data.branchEvents.length > 0) {
    lines.push('\nBRANCH EVENTS:');
    for (const b of data.branchEvents) {
      lines.push(`[${b.repo}] ${n(b.author)} ${b.action} branch: ${b.branch}`);
    }
  }

  if (data.memberEvents.length > 0) {
    lines.push('\nMEMBERSHIP CHANGES:');
    for (const m of data.memberEvents) {
      lines.push(`[${m.repo}] ${n(m.member)} was ${m.action} by ${n(m.actor)}`);
    }
  }

  return lines.join('\n');
}

// --- Gemini Flash via OpenRouter: pre-process raw data (optional) ---

async function preprocessWithGemini(openrouterApiKey, rawData, authorMap) {
  const authorMapStr = Object.entries(authorMap).map(([k, v]) => `${k} → ${v}`).join(', ');
  const ticketPattern = CONFIG.ticketPattern || '';

  const prompt = `You are a data organizer. Process this raw GitHub activity data into a structured summary grouped by person.

Author mapping: ${authorMapStr}

${rawData}

TASK: Organize ALL activity by person (use display names from mapping). For each person, list:

1. COMMITS: repos worked on with commit count and key themes (1 short sentence per repo). Include branch name and one representative commit URL per repo.
2. PRs: opened, merged, closed, or reviewed. Include PR number, title, state, and URL.
3. REVIEWS: which PRs they reviewed and the verdict (approved, changes requested, commented).
4. COMMENTS: what they commented on (issue/PR number and brief topic).
5. ISSUES: issues they opened or closed.
6. RELEASES: any releases they published.
7. BRANCHES: branches they created or deleted.

Also note:
- ${ticketPattern ? `Ticket references (${ticketPattern} patterns from commit messages or PR titles)` : 'Any ticket references from commit messages or PR titles'}
- Dominant repo if one has significantly more activity
- Any membership changes

Output ONLY the structured data — no commentary, no formatting instructions. Keep it concise but complete. Use plain text, not markdown.`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openrouterApiKey}`,
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2500,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter error: ${res.status} — ${body}`);
  }

  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || '';
}

// --- Final LLM call: generate Slack message ---

function generateSlackSummary(structuredData, isPreprocessed) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const ticketPattern = CONFIG.ticketPattern || '';
  const llmCommand = CONFIG.llmCommand || 'claude -p -';

  // Load context if available
  const contextPath = path.join(SCRIPT_DIR, 'context.md');
  const context = fs.existsSync(contextPath) ? fs.readFileSync(contextPath, 'utf8') : '';

  const contextBlock = context ? `\nPROJECT CONTEXT:\n${context}\n` : '';
  const dataLabel = isPreprocessed ? 'ORGANIZED ACTIVITY DATA' : 'RAW ACTIVITY DATA';

  const prompt = `You are a dev activity summarizer. Generate a Slack daily summary from this ${isPreprocessed ? 'pre-organized' : 'raw'} data.
${contextBlock}
Date: ${today}

${dataLabel}:
${structuredData}

FORMAT RULES:
- Use Slack mrkdwn (*bold*, _italic_, \`code\`)
- For links use Slack format: <URL|display text>
- Start with: *Daily Dev Summary — ${today}*
- Group by person — under each person, show a short bullet list of all their activity (commits, PRs, reviews, comments, issues, releases, branches)
- For commits: summarize into one bullet per repo with commit count in parentheses. Include branch name as a clickable compare link (<https://github.com/ORG/REPO/compare/main...BRANCH|branch>)
- If most commits are in one dominant repo, note it once at top (_Most activity in <repo_url|repo>_) and only label bullets for other repos
- For PRs: show state (opened, merged, closed). Link PR number: <pr_url|repo #number>. Split into *New PRs* vs *Open PRs* if both exist, otherwise just *PRs:*
- For reviews: mention what they reviewed and the verdict (approved, changes requested)
- For comments: briefly note what they commented on (don't quote full comments)
- For issues: show opened/closed status
- For releases: show tag and release name
- For branches: mention created/deleted
- For membership changes: note who was added/removed
${ticketPattern ? `- Add *Tickets mentioned:* if any ${ticketPattern} patterns appear` : ''}
- End with a *Notable:* line — one sentence on the main theme of the day
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
  const webhookUrl = CONFIG.slackWebhookUrl;
  if (!dryRun && (!webhookUrl || webhookUrl.includes('XXXXX'))) {
    log('ERROR: slackWebhookUrl not configured');
    process.exit(1);
  }

  // Step 1: Collect all GitHub data
  const data = collectGitData();

  const totalActivity = data.commits.length + data.prs.length + data.reviews.length
    + data.comments.length + data.issues.length + data.releases.length
    + data.branchEvents.length + data.memberEvents.length;

  if (totalActivity === 0) {
    log('No activity found. Skipping summary.');
    process.exit(0);
  }

  const authorMap = CONFIG.authorMap || {};
  const rawData = formatRawData(data, authorMap);

  // Step 2: Gemini Flash pre-processing (optional — only if OPENROUTER_API_KEY is set)
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  let structuredData = rawData;
  let isPreprocessed = false;

  if (openrouterApiKey) {
    log('Running Gemini Flash pre-processing...');
    try {
      const result = await preprocessWithGemini(openrouterApiKey, rawData, authorMap);
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
    log('No OPENROUTER_API_KEY — skipping Gemini pre-processing, using raw data...');
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
    console.log(`Raw: ${data.commits.length} commits, ${data.prs.length} PRs, ${data.reviews.length} reviews, ${data.comments.length} comments, ${data.issues.length} issues, ${data.releases.length} releases, ${data.branchEvents.length} branch events, ${data.memberEvents.length} membership`);
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
