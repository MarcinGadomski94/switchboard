#!/bin/sh
# Switchboard installer for macOS and Linux (docs/setup.md -> One-line install).
#
#   curl -fsSL https://raw.githubusercontent.com/MarcinGadomski94/switchboard/master/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/MarcinGadomski94/switchboard/master/install.sh | sh -s -- --service
#
# Downloads a GitHub release of Switchboard and its .sha256, verifies the checksum
# (nothing is unpacked on a mismatch), unpacks it into <dir>/switchboard-<version>
# (the layout of the manual install, which the in-app updater takes over from:
# docs/updates.md), runs `npm ci --omit=dev`, optionally registers the login
# service (`tools/service/install.ts`) and starts Switchboard. Running it again
# upgrades to the latest release or repairs the installed one.
#
# It never uses sudo, never edits shell profiles and sends no telemetry: the only
# network requests are GitHub (the release) and the npm registry (`npm ci`).
#
# Options:
#   --dir <folder>     install folder (default: ~/Applications/Switchboard on macOS,
#                      ~/.local/opt/switchboard on Linux)
#   --version <x.y.z>  install that release instead of the latest (or SWITCHBOARD_VERSION)
#   --service          also start Switchboard at login (the login service)
#   --no-service       do not register the login service (default without a terminal)
#   --no-start         install only; do not start Switchboard
#   --uninstall        stop it, remove the login service and the install folder; keeps
#                      your data (database, token, logs)
#   --purge            with --uninstall: also remove the data folder
#   --help             this text
#
# Environment: SWITCHBOARD_VERSION, SWITCHBOARD_PORT (default 13001),
# SWITCHBOARD_DATA_DIR, SWITCHBOARD_UPDATE_REPO (owner/name, forks) and, for tests,
# SWITCHBOARD_INSTALL_SOURCE (a folder URL such as file:///tmp/release that holds
# switchboard-<v>.tar.gz and its .sha256).

set -eu

REPO=${SWITCHBOARD_UPDATE_REPO:-MarcinGadomski94/switchboard}
PORT=${SWITCHBOARD_PORT:-13001}
VERSION=${SWITCHBOARD_VERSION:-}
SOURCE=${SWITCHBOARD_INSTALL_SOURCE:-}
DIR=
SERVICE=ask
START=1
UNINSTALL=0
PURGE=0
MARKER_NAME=.switchboard-install
WORK=

say() { printf '%s\n' "$*"; }
warn() { printf 'switchboard install: %s\n' "$*" >&2; }
die() {
  warn "$*"
  exit 1
}

usage() {
  sed -n '2,32p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
  say "See https://github.com/$REPO/blob/master/docs/setup.md"
}

need_value() {
  [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
}

while [ $# -gt 0 ]; do
  case $1 in
    --dir) need_value "$@"; DIR=$2; shift 2 ;;
    --dir=*) DIR=${1#--dir=}; shift ;;
    --version) need_value "$@"; VERSION=$2; shift 2 ;;
    --version=*) VERSION=${1#--version=}; shift ;;
    --service) SERVICE=yes; shift ;;
    --no-service) SERVICE=no; shift ;;
    --no-start) START=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $1 (try --help)" ;;
  esac
done

[ "$PURGE" = 0 ] || [ "$UNINSTALL" = 1 ] || die "--purge only goes with --uninstall"
[ -n "${HOME:-}" ] || die "HOME is not set"

case $(uname -s) in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  *) die "this installer is for macOS and Linux; on Windows use install.ps1 (docs/setup.md)" ;;
esac

if [ -z "$DIR" ]; then
  if [ "$OS" = macos ]; then DIR=$HOME/Applications/Switchboard; else DIR=$HOME/.local/opt/switchboard; fi
fi
case $DIR in
  /*) ;;
  *) DIR=$(pwd)/$DIR ;;
esac
DIR=${DIR%/}
[ -n "$DIR" ] && [ "$DIR" != "$HOME" ] || die "refusing to use $DIR as the install folder"
# The real path, as the login service and the process list name it (no symlinks).
if [ -d "$DIR" ]; then DIR=$(cd "$DIR" && pwd -P); fi

if [ -n "${SWITCHBOARD_DATA_DIR:-}" ]; then
  DATA_DIR=$SWITCHBOARD_DATA_DIR
elif [ "$OS" = macos ]; then
  DATA_DIR="$HOME/Library/Application Support/Switchboard"
else
  case ${XDG_DATA_HOME:-} in
    /*) DATA_DIR=$XDG_DATA_HOME/switchboard ;;
    *) DATA_DIR=$HOME/.local/share/switchboard ;;
  esac
fi
DATA_DIR=${DATA_DIR%/}
if [ -d "$DATA_DIR" ]; then DATA_DIR=$(cd "$DATA_DIR" && pwd -P); fi

case $PORT in
  ''|*[!0-9]*) die "SWITCHBOARD_PORT must be a number, got $PORT" ;;
esac

cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

node_help() {
  warn "$1"
  say ""
  say "Switchboard needs Node.js 24 or newer (with npm) on PATH. Install it, open a new terminal, then run this again:"
  if [ "$OS" = macos ]; then
    say "  brew install node"
    say "or with nvm (https://github.com/nvm-sh/nvm):"
  else
    say "with nvm (https://github.com/nvm-sh/nvm), since distribution packages are often older:"
  fi
  say "  nvm install 24"
  say "Nothing was installed."
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    node_help "Node.js was not found."
    exit 1
  fi
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
  case $major in
    ''|*[!0-9]*) major=0 ;;
  esac
  if [ "$major" -lt 24 ]; then
    node_help "Node.js $(node --version 2>/dev/null || echo '?') is too old."
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    node_help "npm was not found next to Node.js."
    exit 1
  fi
}

# fetch <url> <file>: file:// is copied; anything else is downloaded (curl, else wget).
fetch() {
  case $1 in
    file://*)
      cp "${1#file://}" "$2" || die "cannot read ${1#file://}"
      ;;
    *)
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL --proto-redir '=https' -o "$2" "$1" || die "download failed: $1"
      elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" "$1" || die "download failed: $1"
      else
        die "curl or wget is needed to download Switchboard"
      fi
      ;;
  esac
}

valid_version() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'
}

# The newest x.y.z among switchboard-x.y.z.tar.gz files in a folder.
newest_local() {
  ls "$1" 2>/dev/null \
    | sed -n 's/^switchboard-\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)\.tar\.gz$/\1/p' \
    | sort -t. -k1,1n -k2,2n -k3,3n \
    | tail -n 1
}

resolve_version() {
  if [ -n "$VERSION" ]; then
    VERSION=${VERSION#v}
  elif [ -n "$SOURCE" ]; then
    case $SOURCE in
      file://*) VERSION=$(newest_local "${SOURCE#file://}") ;;
      *) die "SWITCHBOARD_INSTALL_SOURCE needs --version unless it is a file:// folder" ;;
    esac
    [ -n "$VERSION" ] || die "no switchboard-<version>.tar.gz in ${SOURCE#file://}"
  else
    say "Looking up the latest release of $REPO..."
    api=https://api.github.com/repos/$REPO/releases/latest
    json=
    if command -v curl >/dev/null 2>&1; then
      json=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api" 2>/dev/null || true)
    elif command -v wget >/dev/null 2>&1; then
      json=$(wget -q -O - --header='Accept: application/vnd.github+json' "$api" 2>/dev/null || true)
    fi
    VERSION=$(printf '%s\n' "$json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)
    if [ -z "$VERSION" ] && command -v curl >/dev/null 2>&1; then
      latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null || true)
      case $latest in
        */releases/tag/*) VERSION=${latest##*/releases/tag/}; VERSION=${VERSION#v} ;;
      esac
    fi
    [ -n "$VERSION" ] || die "could not find the latest release of $REPO (GitHub rate limit?); pass --version x.y.z"
  fi
  valid_version "$VERSION" || die "\"$VERSION\" is not a release version (x.y.z)"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  else
    die "sha256sum, shasum or openssl is needed to verify the download"
  fi
}

# The hash a .sha256 file gives for <name>: exactly one line `<64 hex>  <name>`
# (or `<64 hex> *<name>`), as `sha256sum` writes it. Empty when it is anything else.
checksum_from() {
  lines=$(grep -c '[^[:space:]]' "$1" || true)
  [ "$lines" = 1 ] || return 0
  line=$(grep '[^[:space:]]' "$1" | tr -d '\r')
  hex=$(printf '%s\n' "$line" | sed -n 's/^\([0-9a-fA-F]\{64\}\) [ *]\(.*\)$/\1/p')
  name=$(printf '%s\n' "$line" | sed -n 's/^[0-9a-fA-F]\{64\} [ *]\(.*\)$/\1/p')
  [ -n "$hex" ] && [ "$name" = "$2" ] || return 0
  printf '%s\n' "$hex" | tr 'A-F' 'a-f'
}

# The login service definition (launchd plist / systemd user unit), as tools/service writes it.
service_file() {
  if [ "$OS" = macos ]; then
    printf '%s\n' "${SWITCHBOARD_SERVICE_HOME:-$HOME}/Library/LaunchAgents/local.switchboard.plist"
  elif [ -n "${SWITCHBOARD_SERVICE_HOME:-}" ]; then
    printf '%s\n' "$SWITCHBOARD_SERVICE_HOME/.config/systemd/user/switchboard.service"
  else
    case ${XDG_CONFIG_HOME:-} in
      /*) printf '%s\n' "$XDG_CONFIG_HOME/systemd/user/switchboard.service" ;;
      *) printf '%s\n' "$HOME/.config/systemd/user/switchboard.service" ;;
    esac
  fi
}

# True when the login service starts a Switchboard from this install (its folder or a
# version the in-app updater installed into the data folder).
service_points_here() {
  file=$(service_file)
  [ -f "$file" ] || return 1
  grep -qF "$DIR/" "$file" && return 0
  grep -qF "$DATA_DIR/versions/" "$file" && return 0
  return 1
}

# The HTTP status of http://127.0.0.1:$PORT/ (000 when nothing answers).
http_status() {
  node -e '
    fetch(process.argv[1], { redirect: "manual", signal: AbortSignal.timeout(3000) })
      .then((r) => console.log(r.status), () => console.log("000"));
  ' "http://127.0.0.1:$PORT/" 2>/dev/null || echo 000
}

# The pid in <dir>/switchboard.pid when it is a Switchboard started from <dir>.
started_pid() {
  pidfile=$DIR/switchboard.pid
  [ -f "$pidfile" ] || return 0
  pid=$(cat "$pidfile" 2>/dev/null || true)
  case $pid in
    ''|*[!0-9]*) return 0 ;;
  esac
  kill -0 "$pid" 2>/dev/null || return 0
  command=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case $command in
    *"$DIR"/switchboard-*/src/server/main.ts*) printf '%s\n' "$pid" ;;
  esac
}

stop_started() {
  pid=$(started_pid)
  if [ -n "$pid" ]; then
    say "Stopping the Switchboard this installer started (pid $pid)..."
    kill "$pid" 2>/dev/null || true
    waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 30 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      warn "pid $pid did not stop within 30 s; stopping it hard"
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$DIR/switchboard.pid"
}

wait_for_answer() {
  waited=0
  while [ "$waited" -lt 60 ]; do
    status=$(http_status)
    [ "$status" != 000 ] && return 0
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# A folder this installer may delete: it made it (the marker), or it holds nothing
# but release folders and the installer's own files (a manual install of the README).
removable_dir() {
  [ "$DIR" != / ] && [ "$DIR" != "$HOME" ] || return 1
  [ -f "$DIR/$MARKER_NAME" ] && return 0
  for entry in "$DIR"/* "$DIR"/.[!.]*; do
    [ -e "$entry" ] || continue
    case ${entry##*/} in
      switchboard-*|.staging-*|switchboard.log|switchboard.pid) ;;
      *) return 1 ;;
    esac
  done
  return 0
}

# Any install folder of this install that still has the service scripts.
any_app_dir() {
  for candidate in "$DIR"/switchboard-* "$DATA_DIR"/versions/*; do
    if [ -f "$candidate/tools/service/uninstall.ts" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
}

uninstall() {
  say "Uninstalling Switchboard from $DIR"
  if [ -d "$DIR" ]; then stop_started; fi
  if service_points_here; then
    app=$(any_app_dir)
    if [ -n "$app" ] && command -v node >/dev/null 2>&1; then
      say "Removing the login service..."
      (cd "$app" && node tools/service/uninstall.ts) || warn "removing the login service failed; run 'npm run service:uninstall' in $app"
    else
      warn "the login service $(service_file) points here but no install is left to remove it; delete that file by hand"
    fi
  elif [ -f "$(service_file)" ]; then
    say "Leaving the login service alone: it starts a Switchboard from another folder ($(service_file))."
  fi
  if [ -d "$DIR" ]; then
    removable_dir || die "$DIR holds files this installer did not make; remove it by hand"
    rm -rf "$DIR"
    say "Removed $DIR"
  else
    say "Nothing installed in $DIR"
  fi
  for folder in "$DATA_DIR/versions" "$DATA_DIR/updates"; do
    if [ -d "$folder" ]; then
      rm -rf "$folder"
      say "Removed $folder (versions the in-app updater installed)"
    fi
  done
  if [ "$PURGE" = 1 ]; then
    [ "$DATA_DIR" != / ] && [ "$DATA_DIR" != "$HOME" ] || die "refusing to purge $DATA_DIR"
    if [ -d "$DATA_DIR" ]; then
      rm -rf "$DATA_DIR"
      say "Removed your data in $DATA_DIR"
    fi
  elif [ -d "$DATA_DIR" ]; then
    say "Kept your data in $DATA_DIR (run with --uninstall --purge to remove it too)"
  fi
}

want_service() {
  case $SERVICE in
    yes) return 0 ;;
    no) return 1 ;;
  esac
  if service_points_here; then
    say "The login service already starts this install: keeping it, pointed at $VERSION."
    return 0
  fi
  if [ -t 1 ] && { : </dev/tty; } 2>/dev/null; then
    printf 'Start Switchboard at login (a per-user login service)? [y/N] '
    answer=
    read -r answer </dev/tty || answer=
    case $answer in
      [yY]|[yY][eE][sS]) return 0 ;;
    esac
  fi
  return 1
}

install() {
  check_node
  resolve_version
  tarball=switchboard-$VERSION.tar.gz
  checksum=$tarball.sha256
  if [ -n "$SOURCE" ]; then base=${SOURCE%/}; else base=https://github.com/$REPO/releases/download/v$VERSION; fi
  app=$DIR/switchboard-$VERSION
  previous=
  if [ -f "$DIR/$MARKER_NAME" ]; then
    previous=$(sed -n 's/^version=//p' "$DIR/$MARKER_NAME" | head -n 1)
  fi
  if [ -d "$app" ]; then say "Repairing Switchboard $VERSION in $app"; else say "Installing Switchboard $VERSION into $app"; fi

  mkdir -p "$DIR"
  DIR=$(cd "$DIR" && pwd -P)
  app=$DIR/switchboard-$VERSION
  WORK=$DIR/.staging-$$
  rm -rf "$WORK"
  mkdir -p "$WORK/unpacked"

  say "Downloading $tarball..."
  fetch "$base/$checksum" "$WORK/$checksum"
  fetch "$base/$tarball" "$WORK/$tarball"
  expected=$(checksum_from "$WORK/$checksum" "$tarball")
  [ -n "$expected" ] || die "$checksum is not a sha256 line for $tarball; nothing was installed"
  actual=$(sha256_of "$WORK/$tarball" | tr 'A-F' 'a-f')
  [ "$actual" = "$expected" ] || die "checksum mismatch for $tarball (expected $expected, got $actual); nothing was installed"
  say "Checksum OK ($actual)"

  entries=$(tar -tzf "$WORK/$tarball") || die "$tarball is not a readable tar.gz"
  outside=$(printf '%s\n' "$entries" | grep -v "^switchboard-$VERSION/" || true)
  dotdot=$(printf '%s\n' "$entries" | grep -E '(^|/)\.\.(/|$)' || true)
  [ -z "$outside" ] && [ -z "$dotdot" ] || die "$tarball has entries outside switchboard-$VERSION/; nothing was installed"
  tar -xzf "$WORK/$tarball" -C "$WORK/unpacked" || die "unpacking $tarball failed"
  staged=$WORK/unpacked/switchboard-$VERSION
  packaged=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$staged/package.json" 2>/dev/null || true)
  [ "$packaged" = "$VERSION" ] || die "the package says version \"$packaged\", not $VERSION"
  [ -f "$staged/src/server/main.ts" ] && [ -f "$staged/dist/web/index.html" ] || die "the package misses src/server/main.ts or dist/web; nothing was installed"

  say "Installing dependencies (npm ci --omit=dev)..."
  (cd "$staged" && npm_config_update_notifier=false npm ci --omit=dev --no-audit --no-fund) || die "npm ci failed; nothing was installed"

  if [ "$START" = 1 ] || [ -d "$app" ]; then stop_started; fi
  if [ -d "$app" ]; then
    mv "$app" "$WORK/replaced"
  fi
  mv "$staged" "$app"
  printf 'version=%s\n' "$VERSION" >"$DIR/$MARKER_NAME"
  say "Installed Switchboard $VERSION in $app"

  started_by_service=0
  if want_service; then
    say "Registering the login service..."
    if [ "$START" = 1 ]; then
      (cd "$app" && node tools/service/install.ts --start) || die "registering the login service failed (see above)"
      started_by_service=1
    else
      (cd "$app" && node tools/service/install.ts) || die "registering the login service failed (see above)"
    fi
  fi

  for old in "$DIR"/switchboard-*; do
    [ -d "$old" ] || continue
    [ "$old" = "$app" ] && continue
    [ -n "$previous" ] && [ "$old" = "$DIR/switchboard-$previous" ] && continue
    if [ -f "$(service_file)" ] && grep -qF "$old/" "$(service_file)"; then continue; fi
    rm -rf "$old"
    say "Removed the older $old"
  done

  url=http://127.0.0.1:$PORT
  if [ "$START" = 0 ]; then
    say ""
    say "Done. Start it with:  cd \"$app\" && npm start   then open $url"
    return 0
  fi
  if [ "$started_by_service" = 0 ]; then
    if [ "$(http_status)" != 000 ]; then
      warn "something already answers on $url (another Switchboard?); not starting a second one"
      say "Stop it first, or set SWITCHBOARD_PORT, then run: cd \"$app\" && npm start"
      return 0
    fi
    say "Starting Switchboard..."
    (
      cd "$app" || exit 1
      nohup node "$app/src/server/main.ts" >>"$DIR/switchboard.log" 2>&1 </dev/null &
      printf '%s\n' "$!" >"$DIR/switchboard.pid"
    )
  fi
  if wait_for_answer; then
    say ""
    say "Switchboard $VERSION is running: open $url"
  else
    warn "Switchboard did not answer on $url within 60 s; see $DIR/switchboard.log"
    exit 1
  fi
  if [ "$started_by_service" = 0 ]; then
    say "It runs in the background (log: $DIR/switchboard.log). Run this installer again with --service to start it at login."
  fi
}

if [ "$UNINSTALL" = 1 ]; then
  uninstall
else
  install
fi
