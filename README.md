# slack-dev-bot

Daily GitHub + Linear activity summarizer + interactive Slack bot. Powered by Claude, or any LLM of your choice.

Posts an AI-generated summary of your team's commits, PRs, reviews, comments, issues, releases, and branch events to Slack every morning. Optionally includes Linear ticket activity in a separate channel. Team members can then ask follow-up questions by mentioning the bot.

## What it does

**Daily git summary (cron):** Scans all repos in your GitHub org, collects commits, PRs, reviews, comments, issues, releases, and branch events. Optionally pre-processes the data with Gemini Flash (cheap) for better structure, then feeds it to your configured LLM for a polished Slack summary.

**Daily Linear summary (cron, optional):** Fetches Linear ticket activity — new/updated issues, status changes, and comments/discussions. Posts to a separate Slack channel.

**Context builder (cron, optional):** Auto-generates the dynamic section of your `context.md` by pulling active Linear tickets and recent Notion spec summaries. Keeps LLM context fresh without manual updates.

**Interactive Q&A (bot):** Listens for @mentions in Slack. When someone asks a question, it feeds the question + recent git/Linear data + project context to the LLM and responds in a thread.

## Example output

```
Daily Dev Summary — Monday, February 09

@Alice — 3 commits
- backend-api — Built new auth middleware and added rate limiting
  Reviews: approved Bob's PR #35

@Bob — 5 commits
- web-app — Redesigned settings page, added dark mode toggle
- shared-lib — Updated date formatting utilities
  Commented on #42 about API contract changes

PRs:
- backend-api #42 merged by @Alice — Add OAuth2 support
- web-app #108 open by @Bob — Settings page redesign

Tickets mentioned: PROJ-123, PROJ-456

Notable: Auth infrastructure overhaul underway alongside UI modernization.
```

## Prerequisites

- **Node.js** 18+ (built-in `fetch` required)
- **GitHub CLI** (`gh`) — authenticated with access to your org's repos
- **An LLM CLI tool** — any command that reads stdin and writes stdout:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude -p -`)
  - [llm](https://llm.datasette.io/) (`llm -m gpt-4o`) — works with OpenAI, Gemini, and many others
  - [Ollama](https://ollama.com/) (`ollama run llama3.1`) — fully local, free
  - Any custom script that reads from stdin
- **jq** and **curl**
- A **Linux server** (for cron + systemd) — tested on Ubuntu 24.04

### Optional

- **OPENROUTER_API_KEY** — enables hybrid LLM mode: Gemini Flash pre-processes raw data (cheap), your configured LLM only handles final formatting. Better summaries, lower cost.
- **LINEAR_API_KEY** — enables Linear ticket activity summaries
- **NOTION_API_KEY** — enables auto-generated context from Notion specs

## Setup

### 1. Clone and configure

```bash
git clone <this-repo> slack-dev-bot
cd slack-dev-bot

cp config.example.json config.json
cp context.example.md context.md
```

Edit `config.json` (see [SETUP.md](SETUP.md) for details):
- `org` — your GitHub organization name
- `llmCommand` — CLI command for your LLM (default: `claude -p -`)
- `slackWebhookUrl` — incoming webhook for daily summaries
- `slackBotToken` / `slackAppToken` — Slack app tokens
- `authorMap` — GitHub username to display name mapping

Optional fields:
- `linearTeamId` — Linear team UUID (enables Linear features)
- `linearOrg` — Linear org slug for URLs (e.g. `your-org`)
- `linearSlackWebhookUrl` — Slack webhook for Linear summary channel
- `linearAuthorMap` — Linear username to display name mapping
- `notionDatabaseId` — Notion database for spec pages

Edit `context.md` with your project details — improves summary quality significantly.

### 2. Create a Slack app

See [SETUP.md](SETUP.md) for step-by-step instructions.

### 3. Set environment variables (for optional features)

```bash
export OPENROUTER_API_KEY="sk-or-..."    # hybrid LLM mode
export LINEAR_API_KEY="lin_api_..."       # Linear integration
export NOTION_API_KEY="ntn_..."           # Notion integration
```

### 4. Run setup

```bash
bash setup.sh
```

## Usage

### Manual dry run
```bash
node git-summary.js --dry-run              # last 24 hours
node git-summary.js --dry-run --hours=168  # last 7 days
node linear-summary.js --dry-run           # Linear activity
node build-context.js --dry-run            # context builder
```

### Ask the bot
Mention the bot in your Slack channel:
- `@Bot what did the team work on today?`
- `@Bot summarize Alice's PRs this week`
- `@Bot what's the status of PROJ-123?`

### Managing the service
```bash
systemctl status slack-dev-bot
systemctl restart slack-dev-bot
journalctl -u slack-dev-bot -f
```

## Files

| File | Purpose |
|---|---|
| `git-summary.js` | Cron — collect git data (commits, PRs, reviews, comments, issues, releases, branches), optional Gemini pre-processing, LLM summary, post to Slack |
| `git-summary.sh` | Legacy bash version (kept for reference) |
| `linear-summary.js` | Cron — collect Linear ticket activity, optional Gemini pre-processing, LLM summary, post to Slack |
| `linear-utils.js` | Shared Linear GraphQL module (used by linear-summary + bot) |
| `build-context.js` | Cron — auto-generate context.md from Linear tickets + Notion specs |
| `bot.js` | Interactive Slack bot — Socket Mode, @mention Q&A with git + Linear data |
| `config.json` | Your configuration (gitignored) |
| `config.example.json` | Template configuration |
| `context.md` | Your project context (gitignored, static + auto-generated sections) |
| `context.example.md` | Template project context |
| `setup.sh` | One-time setup script |

## How it works

### Git summary
1. `git-summary.js` uses `gh api` to list all repos in your org
2. For each repo: fetches commits, PRs, reviews, comments, issues, releases
3. Fetches org events for branch create/delete and membership changes
4. **(Optional)** Sends raw data to Gemini Flash via OpenRouter for structured pre-processing
5. Sends structured (or raw) data to your configured LLM for final Slack formatting
6. Posts to Slack via webhook

### Linear summary
1. `linear-summary.js` queries Linear GraphQL API for recently updated tickets + comments
2. **(Optional)** Gemini Flash pre-processes the data
3. Your LLM formats the final Slack message
4. Posts to a separate Slack channel

### Context builder
1. `build-context.js` reads your `context.md`, preserves the static section above the marker
2. Fetches active Linear tickets (In Progress, Todo, In Review)
3. Fetches recently edited Notion specs, summarizes each with Gemini Flash (or raw text fallback)
4. Writes updated context.md

### Hybrid LLM mode
When `OPENROUTER_API_KEY` is set, scripts use a two-stage pipeline:
- **Stage 1:** Gemini Flash ($0.30/M input) pre-processes raw data — groups by person/ticket, identifies themes, extracts patterns
- **Stage 2:** Your configured LLM only needs to format the polished output into Slack mrkdwn

This produces better summaries at lower cost. Without OpenRouter, raw data goes directly to your LLM (still works, just less structured).

## Recommended cron schedule

```
50 5 * * 1-5  node /path/to/build-context.js  >> logs/context.log 2>&1
0  6 * * 1-5  node /path/to/git-summary.js    >> logs/cron.log 2>&1
2  6 * * 1-5  node /path/to/linear-summary.js >> logs/linear.log 2>&1
```

Context builds first (5:50), then summaries at 6:00 and 6:02 (staggered to avoid concurrent LLM calls).

## License

MIT
