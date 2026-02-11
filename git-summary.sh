#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/config.json"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')]"
DRY_RUN=false
LOOKBACK_HOURS=24

# Parse args
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --hours=*) LOOKBACK_HOURS="${arg#--hours=}" ;;
  esac
done

# Load config
ORG=$(jq -r '.org' "$CONFIG")
SLACK_WEBHOOK=$(jq -r '.slackWebhookUrl' "$CONFIG")
AUTHOR_MAP=$(jq -r '.authorMap' "$CONFIG")
EXTRA_REPOS=$(jq -r '.extraRepos // [] | .[]' "$CONFIG")
TICKET_PATTERN=$(jq -r '.ticketPattern // ""' "$CONFIG")
LLM_CMD=$(jq -r '.llmCommand // "claude -p -"' "$CONFIG")

if [ "$DRY_RUN" = false ] && [[ "$SLACK_WEBHOOK" == *"XXXXX"* ]]; then
  echo "$LOG_PREFIX ERROR: Slack webhook URL not configured"
  exit 1
fi

# Calculate time window (GNU date with macOS fallback)
SINCE=$(date -u -d "$LOOKBACK_HOURS hours ago" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
  || date -u -v-${LOOKBACK_HOURS}H '+%Y-%m-%dT%H:%M:%SZ')
TODAY=$(date '+%A, %B %d')

echo "$LOG_PREFIX Collecting data for $ORG since $SINCE"

# Build list of owner/repo pairs to scan
REPO_LIST=""

# Add all repos from the org
ORG_REPOS=$(gh api "orgs/$ORG/repos" --paginate --jq '.[].name')
for repo in $ORG_REPOS; do
  REPO_LIST="$REPO_LIST $ORG/$repo"
done

# Add extra repos from config
for extra in $EXTRA_REPOS; do
  REPO_LIST="$REPO_LIST $extra"
done

REPO_COUNT=$(echo "$REPO_LIST" | wc -w | tr -d ' ')
echo "$LOG_PREFIX Found $REPO_COUNT repos to scan"

# Collect all commits and PRs
ALL_COMMITS=""
ALL_PRS=""

for full_repo in $REPO_LIST; do
  repo_name=$(basename "$full_repo")
  echo "$LOG_PREFIX Scanning $full_repo..."

  # Get branches
  BRANCHES=$(gh api "repos/$full_repo/branches" --paginate --jq '.[].name' 2>/dev/null || echo "")
  if [ -z "$BRANCHES" ]; then
    echo "$LOG_PREFIX   No branches in $full_repo, skipping"
    continue
  fi

  # Collect commits from all branches, deduplicate by SHA
  SEEN_SHAS=""
  for branch in $BRANCHES; do
    COMMITS=$(gh api "repos/$full_repo/commits?since=$SINCE&sha=$branch&per_page=100" \
      --jq '.[] | [.sha, (.author.login // .commit.author.name // "unknown"), (.commit.message | split("\n") | .[0])] | @tsv' 2>/dev/null || echo "")

    while IFS=$'\t' read -r sha author message; do
      [ -z "$sha" ] && continue
      # Deduplicate by SHA
      if echo "$SEEN_SHAS" | grep -qF "$sha"; then
        continue
      fi
      SEEN_SHAS="$SEEN_SHAS $sha"
      ALL_COMMITS="$ALL_COMMITS
[$repo_name] $author: $message"
    done <<< "$COMMITS"
  done

  # Collect PRs (opened, merged, or updated in the time window)
  PRS=$(gh pr list --repo "$full_repo" --state all \
    --json number,title,author,state,createdAt,mergedAt,updatedAt \
    --limit 50 2>/dev/null || echo "[]")

  # Filter PRs by date
  FILTERED_PRS=$(echo "$PRS" | jq -r --arg since "$SINCE" '
    .[] | select(
      .createdAt >= $since or
      (.mergedAt != null and .mergedAt >= $since) or
      .updatedAt >= $since
    ) | "[\(.state)] #\(.number) \(.title) by @\(.author.login)"
  ' 2>/dev/null || echo "")

  if [ -n "$FILTERED_PRS" ]; then
    while IFS= read -r pr_line; do
      [ -z "$pr_line" ] && continue
      ALL_PRS="$ALL_PRS
[$repo_name] $pr_line"
    done <<< "$FILTERED_PRS"
  fi
done

# Trim leading newlines
ALL_COMMITS=$(echo "$ALL_COMMITS" | sed '/^$/d')
ALL_PRS=$(echo "$ALL_PRS" | sed '/^$/d')

if [ -n "$ALL_COMMITS" ]; then
  COMMIT_COUNT=$(echo "$ALL_COMMITS" | wc -l | tr -d ' ')
else
  COMMIT_COUNT=0
fi
if [ -n "$ALL_PRS" ]; then
  PR_COUNT=$(echo "$ALL_PRS" | wc -l | tr -d ' ')
else
  PR_COUNT=0
fi
echo "$LOG_PREFIX Collected $COMMIT_COUNT commits, $PR_COUNT PRs"

if [ "$COMMIT_COUNT" = "0" ] && [ "$PR_COUNT" = "0" ]; then
  echo "$LOG_PREFIX No activity found. Skipping summary."
  exit 0
fi

# Load context file
CONTEXT_FILE="$SCRIPT_DIR/context.md"
CONTEXT=""
if [ -f "$CONTEXT_FILE" ]; then
  CONTEXT=$(cat "$CONTEXT_FILE")
fi

# Build ticket mention rule
TICKET_RULE=""
if [ -n "$TICKET_PATTERN" ]; then
  TICKET_RULE="- Add *Tickets mentioned:* if any $TICKET_PATTERN patterns appear in commit messages"
fi

# Build Claude prompt
PROMPT="You are a dev activity summarizer. Generate a concise Slack daily summary from the raw commit and PR data below.

PROJECT CONTEXT:
$CONTEXT

Author name mapping (GitHub username → display name):
$(echo "$AUTHOR_MAP" | jq -r 'to_entries | .[] | "  \(.key) → \(.value)"')

Date: $TODAY

COMMITS (format: [repo] author: commit message):
$ALL_COMMITS

PULL REQUESTS (format: [repo] [STATE] #number title by @author):
$ALL_PRS

FORMAT RULES:
- Use Slack mrkdwn (*bold*, _italic_, \`code\`)
- Start with: *Daily Dev Summary — $TODAY*
- Group by person (use display names from mapping; if not in mapping, use the GitHub username as-is)
- For each person, list repos and what they worked on — summarize related commits into one bullet, don't list every commit individually
- Include commit count per person per repo in parentheses
- Add a *PRs:* section if there are PRs (show repo, PR number, title, state, author)
$TICKET_RULE
- End with a *Notable:* line — one sentence highlighting the main theme or pattern of the day
- Omit sections that would be empty
- Output ONLY the Slack message — no code blocks, no explanation, no prefix/suffix"

echo "$LOG_PREFIX Running LLM summary ($LLM_CMD)..."
SUMMARY=$(echo "$PROMPT" | $LLM_CMD 2>/dev/null)

if [ -z "$SUMMARY" ]; then
  echo "$LOG_PREFIX ERROR: Empty summary from LLM"
  exit 1
fi

if [ "$DRY_RUN" = true ]; then
  echo "$LOG_PREFIX DRY RUN — would post to Slack:"
  echo "---"
  echo "$SUMMARY"
  echo "---"
  echo ""
  echo "Raw data collected:"
  echo "=== COMMITS ==="
  echo "$ALL_COMMITS"
  echo "=== PRS ==="
  echo "$ALL_PRS"
  exit 0
fi

# Post to Slack
PAYLOAD=$(jq -n --arg text "$SUMMARY" '{ text: $text }')
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$SLACK_WEBHOOK" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD")

if [ "$HTTP_CODE" = "200" ]; then
  echo "$LOG_PREFIX Posted to Slack successfully"
else
  echo "$LOG_PREFIX ERROR: Slack returned HTTP $HTTP_CODE"
  exit 1
fi
