#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="slack-dev-bot"

echo "=== slack-dev-bot setup ==="
echo ""

# Check prerequisites
for cmd in node npm gh jq curl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is required but not found in PATH"
    exit 1
  fi
done
echo "[ok] All prerequisites found"

# Check Node version (need 18+ for built-in fetch)
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node 18+ required (found $(node -v)). Built-in fetch is needed."
  exit 1
fi
echo "[ok] Node $(node -v)"

# Check LLM command
if [ -f "$SCRIPT_DIR/config.json" ]; then
  LLM_CMD=$(jq -r '.llmCommand // "claude -p -"' "$SCRIPT_DIR/config.json")
  LLM_BIN=$(echo "$LLM_CMD" | awk '{print $1}')
  if ! command -v "$LLM_BIN" &>/dev/null; then
    echo "WARN: LLM command '$LLM_BIN' not found in PATH"
    echo "      Set llmCommand in config.json to your LLM CLI tool"
    echo "      Options: claude -p -, llm -m gpt-4o, ollama run llama3.1"
  else
    echo "[ok] LLM command found: $LLM_CMD"
  fi
fi

# Check gh auth
if ! gh auth status &>/dev/null; then
  echo "ERROR: gh is not authenticated. Run: gh auth login"
  exit 1
fi
echo "[ok] GitHub CLI authenticated"

# Check config
if [ ! -f "$SCRIPT_DIR/config.json" ]; then
  echo "ERROR: config.json not found. Copy config.example.json and fill in your values:"
  echo "  cp config.example.json config.json"
  exit 1
fi
echo "[ok] config.json found"

# Check context
if [ ! -f "$SCRIPT_DIR/context.md" ]; then
  echo "WARN: context.md not found. Copy context.example.md for better summaries:"
  echo "  cp context.example.md context.md"
fi

# Check optional integrations
echo ""
echo "--- Optional integrations ---"

if [ -n "${LINEAR_API_KEY:-}" ]; then
  echo "[ok] LINEAR_API_KEY is set"
  LINEAR_TEAM=$(jq -r '.linearTeamId // ""' "$SCRIPT_DIR/config.json")
  if [ -n "$LINEAR_TEAM" ]; then
    echo "[ok] linearTeamId configured"
  else
    echo "WARN: linearTeamId not set in config.json — Linear summaries will be skipped"
  fi
else
  echo "[--] LINEAR_API_KEY not set — Linear features disabled (optional)"
fi

if [ -n "${NOTION_API_KEY:-}" ]; then
  echo "[ok] NOTION_API_KEY is set"
  NOTION_DB=$(jq -r '.notionDatabaseId // ""' "$SCRIPT_DIR/config.json")
  if [ -n "$NOTION_DB" ]; then
    echo "[ok] notionDatabaseId configured"
  else
    echo "WARN: notionDatabaseId not set in config.json — Notion specs will be skipped"
  fi
else
  echo "[--] NOTION_API_KEY not set — Notion features disabled (optional)"
fi

if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  echo "[ok] OPENROUTER_API_KEY is set — hybrid LLM mode (Gemini pre-processing) enabled"
else
  echo "[--] OPENROUTER_API_KEY not set — single LLM mode (all data to llmCommand directly)"
fi

# Install Node dependencies
echo ""
echo "Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --production

# Make scripts executable
chmod +x "$SCRIPT_DIR/git-summary.js" 2>/dev/null || true
chmod +x "$SCRIPT_DIR/linear-summary.js" 2>/dev/null || true
chmod +x "$SCRIPT_DIR/build-context.js" 2>/dev/null || true

# Test dry run
echo ""
echo "Running dry-run test..."
if node "$SCRIPT_DIR/git-summary.js" --dry-run --hours=48; then
  echo "[ok] Git summary dry run successful"
else
  echo "WARN: Git summary dry run failed — check your config.json (org name, gh auth)"
fi

# Set up systemd service (Linux only)
if command -v systemctl &>/dev/null; then
  echo ""
  read -p "Set up systemd service for the bot? [y/N] " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    CURRENT_USER=$(whoami)
    sudo tee "/etc/systemd/system/$SERVICE_NAME.service" > /dev/null <<EOF
[Unit]
Description=Slack Dev Bot
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$(which node) $SCRIPT_DIR/bot.js
Restart=always
RestartSec=10
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME"
    sudo systemctl start "$SERVICE_NAME"
    echo "[ok] Service $SERVICE_NAME started and enabled"
    echo "     Check status: systemctl status $SERVICE_NAME"
    echo "     View logs:    journalctl -u $SERVICE_NAME -f"
  fi

  # Set up cron
  echo ""
  echo "Recommended cron schedule (Mon-Fri, adjust times to your timezone):"
  echo "  50 5 * * 1-5  node $SCRIPT_DIR/build-context.js    (context builder)"
  echo "  0  6 * * 1-5  node $SCRIPT_DIR/git-summary.js      (git summary)"
  echo "  2  6 * * 1-5  node $SCRIPT_DIR/linear-summary.js   (linear summary)"
  echo ""
  read -p "Set up daily git summary cron job (Mon-Fri 7:00 UTC)? [y/N] " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    CRON_LINE="0 7 * * 1-5 $(which node) $SCRIPT_DIR/git-summary.js >> $SCRIPT_DIR/logs/cron.log 2>&1"
    mkdir -p "$SCRIPT_DIR/logs"
    (crontab -l 2>/dev/null | grep -v "git-summary"; echo "$CRON_LINE") | crontab -
    echo "[ok] Cron job added: $CRON_LINE"
    echo "     Edit with: crontab -e"
    echo "     Add linear-summary.js and build-context.js cron lines manually if needed"
  fi
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit context.md with your project details (improves summary quality)"
echo "  2. Invite the bot to your Slack channel: /invite @YourBotName"
echo "  3. Test: node git-summary.js --dry-run"
echo "  4. Mention the bot in Slack: @YourBotName what did the team work on today?"
echo ""
echo "Optional features (set env vars to enable):"
echo "  - LINEAR_API_KEY + linearTeamId    → Linear ticket summaries"
echo "  - NOTION_API_KEY + notionDatabaseId → Notion spec summaries in context"
echo "  - OPENROUTER_API_KEY               → Hybrid LLM (Gemini pre-processes, your LLM formats)"
