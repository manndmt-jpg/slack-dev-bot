#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="slack-dev-bot"

echo "=== slack-dev-bot setup ==="
echo ""

# Check prerequisites
for cmd in node npm gh claude jq curl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is required but not found in PATH"
    exit 1
  fi
done
echo "[ok] All prerequisites found"

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

# Install Node dependencies
echo ""
echo "Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --production

# Make script executable
chmod +x "$SCRIPT_DIR/git-summary.sh"

# Test dry run
echo ""
echo "Running dry-run test..."
if bash "$SCRIPT_DIR/git-summary.sh" --dry-run --hours=48; then
  echo "[ok] Dry run successful"
else
  echo "WARN: Dry run failed — check your config.json (org name, gh auth)"
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
  read -p "Set up daily cron job (Mon-Fri 7:00 UTC)? [y/N] " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    CRON_LINE="0 7 * * 1-5 $SCRIPT_DIR/git-summary.sh >> $SCRIPT_DIR/logs/cron.log 2>&1"
    mkdir -p "$SCRIPT_DIR/logs"
    (crontab -l 2>/dev/null | grep -v "git-summary.sh"; echo "$CRON_LINE") | crontab -
    echo "[ok] Cron job added: $CRON_LINE"
    echo "     Edit with: crontab -e"
  fi
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit context.md with your project details (improves summary quality)"
echo "  2. Invite the bot to your Slack channel: /invite @YourBotName"
echo "  3. Test: bash git-summary.sh --dry-run"
echo "  4. Mention the bot in Slack: @YourBotName what did the team work on today?"
