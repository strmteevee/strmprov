#!/usr/bin/env bash
# Updates StrmProv on the Raspberry Pi. Run by deploy-pi.bat (copied to /tmp
# and started over ssh); not meant to be run by hand, though it can be.
#
# The server is already installed on the Pi as a git checkout, so this:
#   1. finds that checkout from the running addon-server.js process (or a
#      usual location when nothing is running),
#   2. pulls the latest main, keeping the Pi's own local edits (provider
#      switches from the admin dashboard live in the tracked manifest.json),
#   3. installs npm packages when package.json changed,
#   4. restarts the services those processes belong to (systemd or pm2),
#   5. checks that the addon and the dashboard answer again.
set -u

ADDON_PORT=3100
ADMIN_PORT=3200

say() { printf '\n== %s\n' "$1"; }
fail() { printf '\nERROR: %s\n' "$1" >&2; exit 1; }

# -- 1. Find the checkout --------------------------------------------------
pids_of() { pgrep -f "node .*$1" || true; }

APP_DIR=""
for pid in $(pids_of addon-server.js) $(pids_of admin-server.js); do
  dir=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
  if [ -n "$dir" ] && [ -f "$dir/addon-server.js" ]; then APP_DIR="$dir"; break; fi
done
if [ -z "$APP_DIR" ]; then
  for dir in "$HOME/strmprov" "$HOME/strmprov_dev" "$HOME/services/strmprov" /opt/strmprov \
             $(find "$HOME" -maxdepth 3 -name addon-server.js -not -path "*/node_modules/*" -printf '%h\n' 2>/dev/null); do
    if [ -f "$dir/addon-server.js" ] && [ -d "$dir/.git" ]; then APP_DIR="$dir"; break; fi
  done
fi
[ -n "$APP_DIR" ] || fail "Could not find the StrmProv folder (no running addon-server.js and none of the usual folders)."
[ -d "$APP_DIR/.git" ] || fail "$APP_DIR is not a git checkout."
say "StrmProv folder: $APP_DIR"
cd "$APP_DIR" || fail "Cannot open $APP_DIR"

# -- 2. Pull ---------------------------------------------------------------
say "Pulling the latest version"
OLD=$(git rev-parse HEAD)
# --autostash sets the Pi's own edits (dashboard switches in manifest.json,
# config files) aside for the pull and puts them back afterwards.
git pull --ff-only --autostash || fail "git pull failed - see above. Nothing was restarted."
NEW=$(git rev-parse HEAD)
if [ "$OLD" = "$NEW" ]; then
  echo "Already up to date."
else
  git --no-pager log --oneline "$OLD..$NEW"
fi
if git status --porcelain | grep -q '^UU\|^AA'; then
  fail "Your local changes clash with the update (see git status in $APP_DIR). Nothing was restarted."
fi

# -- 3. npm packages -------------------------------------------------------
if [ "$OLD" != "$NEW" ] && git diff --name-only "$OLD" "$NEW" | grep -q '^package\(-lock\)\?\.json$'; then
  say "package.json changed - installing packages"
  npm install --omit=dev --no-audit --no-fund || fail "npm install failed. Nothing was restarted."
fi

# -- 4. Restart ------------------------------------------------------------
say "Restarting"
UNITS=""
USE_PM2=0
for pid in $(pids_of addon-server.js) $(pids_of admin-server.js) $(pids_of " server.js"); do
  # A service running as root hides its folder from this user; it is then
  # taken to be this checkout (there is one StrmProv on the Pi).
  dir=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
  [ -z "$dir" ] || [ "$dir" = "$APP_DIR" ] || continue
  unit=$(ps -o unit= -p "$pid" 2>/dev/null | tr -d ' ')
  # A systemd user service shows up as user@<uid>.service; its own name is uunit.
  case "$unit" in user@*.service) unit=$(ps -o uunit= -p "$pid" 2>/dev/null | tr -d ' ') ;; esac
  case "$unit" in
    *.service) case " $UNITS " in *" $unit "*) ;; *) UNITS="$UNITS $unit" ;; esac ;;
    *) if ps -o args= -p "$(ps -o ppid= -p "$pid" | tr -d ' ')" 2>/dev/null | grep -qi pm2; then USE_PM2=1; fi ;;
  esac
done

if [ -n "$UNITS" ]; then
  # A user service (systemctl --user) restarts without sudo.
  for unit in $UNITS; do
    if systemctl --user cat "$unit" >/dev/null 2>&1; then
      echo "systemctl --user restart $unit"
      systemctl --user restart "$unit" || fail "Restarting $unit failed."
    else
      echo "sudo systemctl restart $unit"
      sudo systemctl restart "$unit" || fail "Restarting $unit failed."
    fi
  done
elif [ "$USE_PM2" = 1 ]; then
  echo "pm2 restart all"
  pm2 restart all || fail "pm2 restart failed."
else
  fail "The servers are not running as a systemd or pm2 service, so they can't be restarted from here. Restart them the way you started them."
fi

# -- 5. Check --------------------------------------------------------------
say "Checking"
ok=1
for i in $(seq 1 20); do
  sleep 1
  addon=$(curl -s -m 3 "http://127.0.0.1:$ADDON_PORT/manifest.json" | grep -o '"version":"[^"]*"' | head -1)
  admin=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$ADMIN_PORT/api/deploy-config")
  if [ -n "$addon" ] && [ "$admin" = 200 ]; then ok=0; break; fi
done
if [ "$ok" = 0 ]; then
  echo "Addon answers on port $ADDON_PORT ($addon), dashboard on port $ADMIN_PORT."
  echo "Providers: $(grep -c '"filename"' manifest.json) in manifest.json, version $(grep -m1 -o '"version": *"[^"]*"' manifest.json | grep -o '[0-9][0-9.]*')"
else
  echo "Addon: ${addon:-no answer}   Dashboard: HTTP ${admin:-none}"
  fail "A server did not come back within 20 seconds. Check: journalctl -u <service> -n 50"
fi
