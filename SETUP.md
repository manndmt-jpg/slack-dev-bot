# Setup Guide

Complete walkthrough to get slack-dev-bot running on your server.

## What you'll need

- A **Linux server** (Ubuntu/Debian recommended) — any VPS works (Hetzner, DigitalOcean, AWS, etc.)
- A **GitHub account** with access to your org's repos
- A **Slack workspace** where you're an admin (to create apps)
- An **Anthropic API key** for Claude

Total setup time: ~20 minutes.

---

## Step 1: Server prerequisites

SSH into your server and install the required tools.

### Node.js 18+

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version  # should show v22.x
```

### GitHub CLI

```bash
sudo apt install -y gh
gh auth login
# Choose: GitHub.com → HTTPS → Login with a web browser
# Follow the prompts to authenticate
```

Verify access to your org:
```bash
gh api orgs/YOUR-ORG-NAME/repos --jq '.[].name'
```

### Claude Code CLI

```bash
npm install -g @anthropic-ai/claude-code
```

Set your API key:
```bash
echo 'export ANTHROPIC_API_KEY="sk-ant-your-key-here"' >> ~/.bashrc
source ~/.bashrc
```

Test it:
```bash
echo "Say hello" | claude -p -
```

### Other tools

```bash
sudo apt install -y jq curl
```

---

## Step 2: Clone and configure

```bash
cd ~  # or wherever you keep projects
git clone https://github.com/manndmt-jpg/slack-dev-bot.git
cd slack-dev-bot
```

### Create your config

```bash
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "org": "your-github-org",
  "extraRepos": [],
  "slackWebhookUrl": "...",
  "slackBotToken": "xoxb-...",
  "slackAppToken": "xapp-...",
  "ticketPattern": "PROJ-\\d+",
  "authorMap": {
    "github-username": "Display Name"
  }
}
```

**Fields explained:**

| Field | What to put |
|---|---|
| `org` | Your GitHub organization name (from the URL: github.com/**your-org**) |
| `extraRepos` | Repos outside your org to also scan, e.g. `["other-org/some-repo"]`. Leave `[]` if not needed |
| `slackWebhookUrl` | From Step 3 below |
| `slackBotToken` | From Step 3 below (starts with `xoxb-`) |
| `slackAppToken` | From Step 3 below (starts with `xapp-`) |
| `ticketPattern` | Regex for your ticket IDs in commit messages. Examples: `PROJ-\\d+`, `JIRA-\\d+`, `#\\d+`. Leave `""` to skip |
| `authorMap` | Maps GitHub usernames to display names. Find usernames from your team's GitHub profiles |

### Create your context file

```bash
cp context.example.md context.md
```

Edit `context.md` with details about your project. This is optional but **strongly recommended** — it makes the summaries much more useful. Include:

- What your company/product does
- What each repo is for
- Who's on the team and what they work on
- Domain-specific terminology
- Current priorities

The more context you provide, the better the AI summaries will be.

---

## Step 3: Create a Slack app

Go to **https://api.slack.com/apps** and click **Create New App** → **From scratch**.

- **App Name:** whatever you want (e.g. "Dev Bot")
- **Workspace:** your Slack workspace

### 3a. Enable Socket Mode

1. Left sidebar → **Socket Mode**
2. Toggle **Enable Socket Mode** → ON
3. It asks you to create an App-Level Token:
   - Token Name: `socket-token`
   - Add scope: `connections:write`
   - Click **Generate**
4. **Copy the token** (starts with `xapp-`) → paste into `config.json` as `slackAppToken`

### 3b. Set up events

1. Left sidebar → **Event Subscriptions**
2. Toggle **Enable Events** → ON
3. Expand **Subscribe to bot events**
4. Click **Add Bot User Event** and add:
   - `app_mention`
   - `message.channels`
5. Click **Save Changes**

### 3c. Set up permissions

1. Left sidebar → **OAuth & Permissions**
2. Scroll to **Bot Token Scopes**
3. Add these scopes:
   - `app_mentions:read`
   - `channels:history`
   - `channels:read`
   - `chat:write`
4. Scroll back up and click **Install to Workspace** (or **Reinstall** if updating)
5. Click **Allow**
6. **Copy the Bot User OAuth Token** (starts with `xoxb-`) → paste into `config.json` as `slackBotToken`

### 3d. Create an incoming webhook

1. Left sidebar → **Incoming Webhooks**
2. Toggle **Activate Incoming Webhooks** → ON
3. Click **Add New Webhook to Workspace**
4. Select the channel where you want daily summaries (e.g. `#dev-summary`)
5. Click **Allow**
6. **Copy the Webhook URL** → paste into `config.json` as `slackWebhookUrl`

### 3e. Invite the bot to your channel

In Slack, go to the channel and type:
```
/invite @YourBotName
```

---

## Step 4: Build your author map

To find GitHub usernames for your team, check your org's members page:
```
https://github.com/orgs/YOUR-ORG/people
```

Or run this to see who's been committing recently:
```bash
gh api orgs/YOUR-ORG/repos --paginate --jq '.[].name' | while read repo; do
  gh api "repos/YOUR-ORG/$repo/commits?per_page=10" \
    --jq '.[] | .author.login // .commit.author.name' 2>/dev/null
done | sort -u
```

Add each username to the `authorMap` in `config.json`:
```json
"authorMap": {
  "alice-gh": "Alice",
  "bob123": "Bob",
  "charlie-dev": "Charlie"
}
```

Usernames not in the map will show as-is in summaries (not an error, just less pretty).

---

## Step 5: Run setup

```bash
bash setup.sh
```

This checks prerequisites, installs dependencies, runs a dry-run test, and optionally sets up:
- A **systemd service** for the interactive bot (keeps it running 24/7)
- A **cron job** for the daily summary (default: Mon-Fri at 7:00 UTC)

### Or do it manually

Install deps:
```bash
npm install
```

Test the summary:
```bash
bash git-summary.sh --dry-run
```

Start the bot:
```bash
node bot.js
```

---

## Step 6: Customize the schedule

The setup script creates a cron at 7:00 UTC. To change it:

```bash
crontab -e
```

The line looks like:
```
0 7 * * 1-5 /path/to/slack-dev-bot/git-summary.sh >> /path/to/slack-dev-bot/logs/cron.log 2>&1
```

Cron format: `minute hour * * days-of-week`

Common schedules:
| Schedule | Cron | UTC note |
|---|---|---|
| 8:00 AM CET (Berlin winter) | `0 7 * * 1-5` | CET = UTC+1 |
| 9:00 AM EST (New York winter) | `0 14 * * 1-5` | EST = UTC-5 |
| 9:00 AM PST (SF winter) | `0 17 * * 1-5` | PST = UTC-8 |

---

## Verify it works

### Test the daily summary
```bash
# Last 24 hours
bash git-summary.sh --dry-run

# Last 7 days (more data to see)
bash git-summary.sh --dry-run --hours=168
```

### Test the bot
In your Slack channel, type:
```
@YourBotName what did the team work on recently?
```

The bot should react with eyes while thinking, then respond in a thread.

### Check service status
```bash
systemctl status slack-dev-bot
journalctl -u slack-dev-bot --since "10 min ago"
```

### Check cron output
```bash
# After the scheduled time
cat logs/cron.log
```

---

## Troubleshooting

**"No activity found"** — your lookback window might be too short, or the org name is wrong. Try `--hours=168` for a week of data.

**"gh: Not Found"** — your GitHub token doesn't have access to the org. Re-run `gh auth login` and ensure you have the `read:org` and `repo` scopes.

**Bot doesn't respond in Slack** — check that Socket Mode is enabled, the bot is invited to the channel, and `app_mention` event is subscribed. Check logs: `journalctl -u slack-dev-bot -f`

**"Empty summary from Claude"** — Claude CLI might not be in PATH or the API key isn't set. Test with: `echo "test" | claude -p -`

**Cron runs but nothing posts** — check `logs/cron.log`. Common issue: cron doesn't load your shell profile, so `claude` or `gh` aren't in PATH. Add full paths to the cron line or add `export PATH=...` at the top of `git-summary.sh`.
