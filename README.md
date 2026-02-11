# slack-dev-bot

Daily GitHub activity summarizer + interactive Slack bot powered by Claude.

Posts an AI-generated summary of your team's commits and PRs to Slack every morning. Team members can then ask follow-up questions by mentioning the bot.

## What it does

**Daily summary (cron):** Scans all repos in your GitHub org, collects commits from every branch (deduplicated), gathers PRs, feeds everything to Claude with your project context, and posts a formatted summary to Slack.

**Interactive Q&A (bot):** Listens for @mentions in Slack. When someone asks a question like "what did Alice work on today?", it feeds the question + recent git data + project context to Claude and responds in a thread.

## Example output

```
Daily Dev Summary — Monday, February 09

@Alice — 3 commits
- backend-api — Built new auth middleware and added rate limiting

@Bob — 5 commits
- web-app — Redesigned settings page, added dark mode toggle
- shared-lib — Updated date formatting utilities

PRs:
- backend-api #42 merged by @Alice — Add OAuth2 support
- web-app #108 open by @Bob — Settings page redesign

Tickets mentioned: PROJ-123, PROJ-456

Notable: Auth infrastructure overhaul underway alongside UI modernization.
```

## Prerequisites

- **Node.js** 18+
- **GitHub CLI** (`gh`) — authenticated with access to your org's repos
- **An LLM CLI tool** — any command that reads stdin and writes stdout. Supported out of the box:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude -p -`)
  - [llm](https://llm.datasette.io/) (`llm -m gpt-4o`) — works with OpenAI, Gemini, and many others
  - [Ollama](https://ollama.com/) (`ollama run llama3.1`) — fully local, free
  - Any custom script that reads from stdin
- **jq** and **curl**
- A **Linux server** (for cron + systemd) — tested on Ubuntu 24.04

## Setup

### 1. Clone and configure

```bash
git clone <this-repo> slack-dev-bot
cd slack-dev-bot

cp config.example.json config.json
cp context.example.md context.md
```

Edit `config.json`:
- `org` — your GitHub organization name
- `extraRepos` — additional repos outside the org (e.g. `["other-org/repo"]`)
- `llmCommand` — CLI command for your LLM (default: `claude -p -`). See prerequisites for options
- `slackWebhookUrl` — incoming webhook URL for your Slack channel
- `slackBotToken` — bot token (`xoxb-...`) from your Slack app
- `slackAppToken` — app-level token (`xapp-...`) for Socket Mode
- `ticketPattern` — regex for ticket references in commits (e.g. `"PROJ-\\d+"`)
- `authorMap` — GitHub username to display name mapping

Edit `context.md` with your project details — this gives the LLM context about your product, repos, team, and terminology for better summaries.

### 2. Create a Slack app

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. **Socket Mode** → toggle ON → generate App-Level Token with `connections:write` scope
3. **Event Subscriptions** → toggle ON → subscribe to `app_mention` and `message.channels`
4. **OAuth & Permissions** → add bot scopes: `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`
5. **Install to Workspace** → copy the Bot User OAuth Token

Put the tokens in `config.json`.

### 3. Run setup

```bash
bash setup.sh
```

This will:
- Check all prerequisites
- Install Node dependencies
- Run a dry-run test
- Optionally set up a systemd service for the bot
- Optionally set up a daily cron job

### 4. Invite the bot

In your Slack channel:
```
/invite @YourBotName
```

## Usage

### Manual dry run
```bash
bash git-summary.sh --dry-run              # last 24 hours
bash git-summary.sh --dry-run --hours=168  # last 7 days
```

### Ask the bot
Mention the bot in your Slack channel:
- `@Bot what did the team work on today?`
- `@Bot summarize Alice's PRs this week`
- `@Bot any tickets mentioned in recent commits?`

### Managing the service
```bash
systemctl status slack-dev-bot
systemctl restart slack-dev-bot
journalctl -u slack-dev-bot -f
```

## Files

| File | Purpose |
|---|---|
| `git-summary.sh` | Cron script — collect git data, summarize with Claude, post to Slack |
| `bot.js` | Interactive Slack bot — Socket Mode, @mention Q&A |
| `config.json` | Your configuration (gitignored — contains secrets) |
| `config.example.json` | Template configuration |
| `context.md` | Your project context for Claude (gitignored) |
| `context.example.md` | Template project context |
| `setup.sh` | One-time setup script |

## How it works

1. `git-summary.sh` uses `gh api` to list all repos in your org + extra repos
2. For each repo: lists all branches, fetches commits since the lookback window, deduplicates by SHA
3. Collects PRs (opened/merged/updated in the same window)
4. Feeds structured data + `context.md` to `claude -p` with formatting instructions
5. Posts the result to Slack via webhook (cron) or responds in thread (bot)

## License

MIT
