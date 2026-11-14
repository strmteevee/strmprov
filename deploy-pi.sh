#!/usr/bin/env bash
# Updates StrmProv on the Raspberry Pi. Run by deploy-pi.bat (copied to /tmp
# and started over ssh); not meant to be run by hand, though it can be.
#
# The server is already installed on the Pi as a git checkout, so this:
#   1. finds that checkout from the running addon-server.js process (or a
#      usual location when nothing is running),
#   2. pulls the latest main, keeping the Pi's own local edits (provider
#      switches from the admin dashboard live in the tracked manifest.json,
#      which is handled separately - see the comment at the pull),
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
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi
command -v node >/dev/null 2>&1 || fail "node not found in this shell. Nothing was changed."

# manifest.json holds both the provider list (from git) and the dashboard's
# switches (on the Pi), so it must never go through a git merge: when an update
# removes a provider, that gives a conflict, and conflict markers in the file
# leave the running servers with no providers at all (seen 2026-11-05, when
# this script still used --autostash for it). The Pi's own changes are instead
# worked out field by field against the committed version, and put back on top
# of the new one after the pull.
SAVED=.git/strmprov-manifest-local.json
BASE=.git/strmprov-manifest-base.json

# Left behind by an earlier run of this script: keep the update's side of the
# conflict. Changes outside the conflict are already merged into the file.
if git diff --name-only --diff-filter=U | grep -qx manifest.json; then
  echo "Repairing the conflict an earlier update left in manifest.json"
  sed -i -e '/^<<<<<<< /d' -e '/^=======\r\?$/,/^>>>>>>> /d' manifest.json
  git reset -q -- manifest.json
fi
UNMERGED=$(git diff --name-only --diff-filter=U)
[ -z "$UNMERGED" ] || fail "Unresolved conflict in: $UNMERGED (see git status in $APP_DIR). Nothing was restarted."
node -e 'JSON.parse(require("fs").readFileSync("manifest.json", "utf8"))' 2>/dev/null \
  || fail "manifest.json is not valid JSON and could not be repaired. Nothing was restarted."

OLD=$(git rev-parse HEAD)
cp manifest.json "$SAVED" || fail "Could not save manifest.json. Nothing was changed."
git show HEAD:manifest.json > "$BASE" || fail "Could not read the committed manifest.json. Nothing was changed."
git checkout -- manifest.json || fail "Could not reset manifest.json. Nothing was changed."

# --autostash keeps any other local edit (config files) across the pull.
if ! git pull --ff-only --autostash; then
  cp "$SAVED" manifest.json
  fail "git pull failed - see above. manifest.json was put back and nothing was restarted."
fi

node -e '
const fs = require("fs");
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const [saved, base, current] = [process.argv[1], process.argv[2], "manifest.json"].map(read);
const byId = (m) => new Map(m.scrapers.map((s) => [s.id, s]));
const baseById = byId(base), savedById = byId(saved), currentById = byId(current);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const notes = [];
for (const entry of saved.scrapers) {
  const was = baseById.get(entry.id), now = currentById.get(entry.id);
  if (!was) {
    if (!now) { current.scrapers.push(entry); notes.push(`kept your own provider ${entry.id}`); }
  } else if (now) {
    for (const key of Object.keys(entry)) {
      if (!same(entry[key], was[key]) && !same(entry[key], now[key])) {
        now[key] = entry[key];
        notes.push(`${entry.id}: kept your ${key}${key === "enabled" ? ` (${entry.enabled ? "on" : "off"})` : ""}`);
      }
    }
  }
}
const removed = base.scrapers.filter((s) => !savedById.has(s.id) && currentById.has(s.id)).map((s) => s.id);
if (removed.length) {
  current.scrapers = current.scrapers.filter((s) => !removed.includes(s.id));
  notes.push(`stays removed: ${removed.join(", ")}`);
}
if (notes.length) fs.writeFileSync("manifest.json", JSON.stringify(current, null, 2) + "\n");
console.log(notes.length ? `Dashboard settings kept:\n  ${notes.join("\n  ")}` : "No dashboard settings to keep.");
' "$SAVED" "$BASE" || fail "Could not put the dashboard settings back; your copy is in $APP_DIR/$SAVED. Nothing was restarted."

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

# Memory settings for the Node processes, as a systemd drop-in next to each
# service (the service files themselves are the Pi's own and stay untouched).
# Node's defaults suit a big machine: a 16MB young generation and a heap limit
# of several GB let it collect late and keep what it once grew to. A stream
# search runs ~27 providers at once, which sent the addon from 34MB to 183MB
# (measured 2026-11-14), and it stayed above 115MB afterwards; with these it
# peaked at 95MB and settled at 90MB, with the same streams in the same time.
# MALLOC_ARENA_MAX keeps glibc from holding a memory pool per CPU core.
MEMORY_DROPIN='[Service]
Environment="NODE_OPTIONS=--max-semi-space-size=2 --max-old-space-size=256"
Environment="MALLOC_ARENA_MAX=2"'
memory_dropin() { # $1 = folder for the unit's drop-ins, $2 = command prefix (sudo or nothing)
  [ "$(cat "$1/strmprov-memory.conf" 2>/dev/null)" = "$MEMORY_DROPIN" ] && return 1
  $2 mkdir -p "$1" && printf '%s\n' "$MEMORY_DROPIN" | $2 tee "$1/strmprov-memory.conf" >/dev/null
}

if [ -n "$UNITS" ]; then
  # A user service (systemctl --user) restarts without sudo.
  for unit in $UNITS; do
    if systemctl --user cat "$unit" >/dev/null 2>&1; then
      if memory_dropin "$HOME/.config/systemd/user/$unit.d" ""; then
        echo "Memory settings added to $unit"; systemctl --user daemon-reload
      fi
      echo "systemctl --user restart $unit"
      systemctl --user restart "$unit" || fail "Restarting $unit failed."
    else
      if memory_dropin "/etc/systemd/system/$unit.d" sudo; then
        echo "Memory settings added to $unit"; sudo systemctl daemon-reload
      fi
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
