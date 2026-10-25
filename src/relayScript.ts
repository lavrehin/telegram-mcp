/**
 * The relay's installer, served at /relay/install.sh. One command on any
 * always-on Linux machine (an Oracle free VM will do):
 *
 *   curl -fsSL https://<worker>/relay/install.sh | RELAY_TOKEN=relay_… bash
 *
 * Run again without RELAY_TOKEN, it updates the relay and keeps its token.
 * It installs curl, jq and Claude Code if missing, writes ~/.tg-relay/relay.sh
 * and a systemd service running it as the current user, and starts it. The
 * relay only asks the Worker for work, so it needs no open port, domain or
 * public address. Claude Code must be signed in once on that machine
 * (`claude`, then /login) — the relay writes to sessions as that account.
 *
 * The shell's own `${…}` would clash with the template, so the scripts do
 * without it (where it must, it is spelled ${"$"}{…}).
 */

const RELAY_LOOP = String.raw`#!/usr/bin/env bash
# Passes messages from the Telegram bot into Claude Code cloud sessions.
set -uo pipefail
API="$RELAY_ORIGIN/relay"
# The token goes to curl from a file, never on its command line, where ps would show it.
AUTH=$(umask 077 && mktemp)
trap 'rm -f "$AUTH"' EXIT
printf 'Authorization: Bearer %s\n' "$RELAY_TOKEN" >"$AUTH"
START=1
while true; do
  # The Worker holds the request until a job comes, up to 25 s: no busy polling, no delay.
  ASKED=$(date +%s)
  JOBS=$(curl -fsS --max-time 40 -H @"$AUTH" "$API/jobs?wait=25&start=$START") || { sleep 20; continue; }
  START=0
  COUNT=$(printf '%s' "$JOBS" | jq 'length' 2>/dev/null || echo 0)
  for ((i = 0; i < COUNT; i++)); do
    JOB=$(printf '%s' "$JOBS" | jq -c ".[$i]")
    ID=$(printf '%s' "$JOB" | jq -r .id)
    SESSION=$(printf '%s' "$JOB" | jq -r .session)
    ERR=$(mktemp)
    OUT=$(printf '%s' "$JOB" | jq -r .text | timeout 300 claude -p --cloud "$SESSION" --output-format json 2>"$ERR")
    CODE=$?
    if [ "$CODE" -eq 0 ] && [ "$(printf '%s' "$OUT" | jq -rs '.[0].ok // false' 2>/dev/null)" = "true" ]; then
      REPORT='{"ok":true}'
    else
      [ "$CODE" -eq 124 ] && echo "timed out after 300 s" >>"$ERR"
      REPORT=$(jq -cn --arg out "$OUT" --arg err "$(cat "$ERR")" --arg code "$CODE" \
        '{ok:false, error:((($out|fromjson?).error) // (($err + " " + $out) | if test("^\\s*$") then "claude exited with " + $code else . end))}')
    fi
    rm -f "$ERR"
    printf '%s' "$REPORT" | curl -fsS --max-time 30 -X POST -H @"$AUTH" -H 'Content-Type: application/json' --data-binary @- "$API/jobs/$ID" >/dev/null || true
    echo "$(date -u +%FT%TZ) $ID -> $SESSION: $REPORT"
  done
  # An empty answer that came at once means the Worker did not wait (signed out, say): slow down.
  if ! [ "$COUNT" -gt 0 ] 2>/dev/null && [ $(($(date +%s) - ASKED)) -lt 5 ]; then sleep 10; fi
done
`;

export function installScript(origin: string): string {
  return String.raw`#!/usr/bin/env bash
# Installs the Telegram bot's relay, which passes messages into Claude Code cloud sessions.
# Everything is inside main, run on the last line: a download cut short runs nothing.
set -euo pipefail
main() {
ORIGIN='${origin.replaceAll("'", "")}'
# Run again without a token, it updates the relay and keeps the one it has.
if [ -z "${"$"}{RELAY_TOKEN:-}" ] && [ -f "$HOME/.tg-relay/env" ]; then
  RELAY_TOKEN=$(sed -n 's/^RELAY_TOKEN=//p' "$HOME/.tg-relay/env")
fi
if [ -z "${"$"}{RELAY_TOKEN:-}" ]; then
  echo "Run it as: curl -fsSL $ORIGIN/relay/install.sh | RELAY_TOKEN=relay_... bash" >&2
  exit 1
fi
have() { command -v "$1" >/dev/null 2>&1; }
if ! have curl || ! have jq; then
  if have apt-get; then sudo apt-get update -qq </dev/null && sudo apt-get install -y -qq curl jq </dev/null
  elif have dnf; then sudo dnf install -y -q curl jq </dev/null
  elif have yum; then sudo yum install -y -q curl jq </dev/null
  else echo "Install curl and jq, then run this again." >&2; exit 1; fi
fi
export PATH="$HOME/.local/bin:$PATH"
if ! have claude; then curl -fsSL https://claude.ai/install.sh | bash </dev/null; fi
CLAUDE_DIR=$(dirname "$(command -v claude)")

DIR="$HOME/.tg-relay"
mkdir -p "$DIR" && chmod 700 "$DIR"
printf 'RELAY_TOKEN=%s\nRELAY_ORIGIN=%s\n' "$RELAY_TOKEN" "$ORIGIN" >"$DIR/env"
chmod 600 "$DIR/env"
cat >"$DIR/relay.sh" <<'RELAY'
${RELAY_LOOP}RELAY
chmod 700 "$DIR/relay.sh"

sudo tee /etc/systemd/system/tg-relay.service >/dev/null <<UNIT
[Unit]
Description=Telegram bot relay to Claude Code sessions
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$HOME
EnvironmentFile=$DIR/env
Environment=PATH=$CLAUDE_DIR:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash $DIR/relay.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now tg-relay >/dev/null
sudo systemctl restart tg-relay

echo
echo "The relay is running (logs: journalctl -u tg-relay -f)."
if ! claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then
  echo "Now sign Claude Code in once: run claude, then /login. Then: sudo systemctl restart tg-relay"
else
  echo "Claude Code is signed in. After any new /login, run: sudo systemctl restart tg-relay"
fi
}
main "$@"
`;
}
