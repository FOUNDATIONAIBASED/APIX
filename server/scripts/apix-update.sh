#!/usr/bin/env bash
# =============================================================================
# ApiX Gateway — safe in-place update (Git)
# Backs up SQLite data + git state, pulls latest, npm install, verifies, restarts.
# On any failure: restores previous git commit + data directory and writes logs.
#
# Usage:
#   ./scripts/apix-update.sh              # from server/ directory, or:
#   bash /path/to/server/scripts/apix-update.sh
#
# Environment (optional):
#   APIX_GIT_BRANCH=main          — branch to pull (default: main)
#   APIX_GIT_REMOTE=origin      — remote name
#   APIX_BACKUP_ROOT=...        — override backup parent dir (default: server/.apix-backups/updates)
#   APIX_SKIP_SERVICE_STOP=1    — do not stop systemd / PID (you stopped server manually)
#   APIX_SKIP_SERVICE_START=1   — do not start after success (print instructions only)
#   APIX_KEEP_BACKUPS=15        — number of update sessions to keep
#
# Official repo: https://github.com/FOUNDATIONAIBASED/APIX
# =============================================================================

# Do not use 'set -e' globally — we handle errors and revert explicitly.
set -u
set -o pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_PARENT="${APIX_BACKUP_ROOT:-$SERVER_DIR/.apix-backups/updates}"
STAMP="$(date +%Y%m%d_%H%M%S)"
SESSION_DIR="$BACKUP_PARENT/$STAMP"
ERROR_LOG="$SESSION_DIR/update-error.log"
MAIN_LOG="$SESSION_DIR/update.log"
GIT_BRANCH="${APIX_GIT_BRANCH:-main}"
GIT_REMOTE="${APIX_GIT_REMOTE:-origin}"
KEEP_N="${APIX_KEEP_BACKUPS:-15}"

mkdir -p "$SESSION_DIR"
touch "$ERROR_LOG" "$MAIN_LOG"

log() {
  local line="[$(date -Iseconds)] $*"
  echo "$line" | tee -a "$MAIN_LOG"
}

log_err() {
  local line="[$(date -Iseconds)] ERROR: $*"
  echo "$line" | tee -a "$ERROR_LOG" | tee -a "$MAIN_LOG"
}

get_env_val() {
  local key="$1" default="${2:-}"
  local f="$SERVER_DIR/.env"
  if [[ -f "$f" ]]; then
    local val
    val=$(grep -E "^${key}=" "$f" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
    echo "${val:-$default}"
  else
    echo "$default"
  fi
}

find_git_root() {
  local d="$SERVER_DIR"
  while [[ "$d" != "/" ]]; do
    if [[ -d "$d/.git" ]]; then
      echo "$d"
      return 0
    fi
    d="$(dirname "$d")"
  done
  return 1
}

resolve_db_file() {
  local dbp
  dbp="$(get_env_val DB_PATH "./data/apix.db")"
  if [[ "$dbp" = /* ]]; then
    echo "$dbp"
  else
    echo "$SERVER_DIR/$dbp"
  fi
}

resolve_data_dir() {
  dirname "$(resolve_db_file)"
}

# True if data directory lives under server/ (safe to rm -rf on restore).
data_dir_is_under_server() {
  local dd="$1"
  local real_dd real_srv
  real_srv="$(cd "$SERVER_DIR" && pwd -P 2>/dev/null)" || return 1
  real_dd="$(cd "$dd" 2>/dev/null && pwd -P 2>/dev/null)" || return 1
  [[ "$real_dd" == "$real_srv"/* ]] || [[ "$real_dd" == "$real_srv" ]]
}

stop_server() {
  if [[ "${APIX_SKIP_SERVICE_STOP:-}" == "1" ]]; then
    log "Skipping service stop (APIX_SKIP_SERVICE_STOP=1)"
    return 0
  fi

  if systemctl is-active --quiet apix-gateway 2>/dev/null; then
    log "Stopping systemd unit apix-gateway..."
    if sudo -n systemctl stop apix-gateway 2>/dev/null || systemctl stop apix-gateway 2>/dev/null; then
      ok_stop=1
    else
      sudo systemctl stop apix-gateway || log_err "Could not stop apix-gateway — stop it manually and re-run with APIX_SKIP_SERVICE_STOP=1"
    fi
    sleep 2
    return 0
  fi

  local pid_file="$SERVER_DIR/.apix.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      log "Stopping process from .apix.pid (PID $pid)..."
      kill "$pid" 2>/dev/null || true
      sleep 2
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi

  local port
  port="$(get_env_val PORT 3000)"
  if command -v lsof &>/dev/null; then
    local pids
    pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      log "Port $port still in use by PID(s): $pids — sending SIGTERM..."
      for p in $pids; do kill "$p" 2>/dev/null || true; done
      sleep 2
      for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
    fi
  fi
}

backup_data_dir() {
  local data_dir="$1"
  local db_file
  db_file="$(resolve_db_file)"

  # 1) Default layout: whole data/ under server/ (safe rm -rf on restore)
  if [[ -d "$data_dir" ]] && data_dir_is_under_server "$data_dir"; then
    echo "dir" > "$SESSION_DIR/backup_data_mode.txt"
    log "Archiving data directory: $data_dir"
    if tar czf "$SESSION_DIR/data.tar.gz" -C "$(dirname "$data_dir")" "$(basename "$data_dir")" 2>>"$MAIN_LOG"; then
      log "Data backup: $SESSION_DIR/data.tar.gz ($(du -h "$SESSION_DIR/data.tar.gz" | cut -f1))"
      return 0
    fi
    log_err "Failed to create data.tar.gz"
    return 1
  fi

  # 2) DB outside server/: copy single file only (never tarball arbitrary parent dirs)
  if [[ -f "$db_file" ]]; then
    echo "file" > "$SESSION_DIR/backup_data_mode.txt"
    log "Database path is outside server/ — backing up SQLite file only."
    mkdir -p "$SESSION_DIR/db_file_backup"
    if cp -a "$db_file" "$SESSION_DIR/db_file_backup/apix_restore.db" 2>>"$MAIN_LOG"; then
      log "DB file backup: $SESSION_DIR/db_file_backup/apix_restore.db"
      return 0
    fi
    log_err "Failed to copy database file"
    return 1
  fi

  echo "none" > "$SESSION_DIR/backup_data_mode.txt"
  log "No data directory under server/ and no DB file yet — skipping data backup."
  return 0
}

backup_server_tree() {
  log "Archiving server tree (excl. node_modules, .apix-backups)..."
  tar czf "$SESSION_DIR/server_tree.tar.gz" \
    --exclude=node_modules \
    --exclude=.apix-backups \
    -C "$SERVER_DIR" . 2>>"$MAIN_LOG" || true
}

restore_data_dir() {
  local data_dir="$1"
  local mode
  mode="$(cat "$SESSION_DIR/backup_data_mode.txt" 2>/dev/null || echo none)"

  if [[ "$mode" == "file" ]]; then
    local db_file dest
    db_file="$(resolve_db_file)"
    dest="$SESSION_DIR/db_file_backup/apix_restore.db"
    [[ -f "$dest" ]] || return 0
    log "Restoring SQLite file from backup (external DB path)..."
    mkdir -p "$(dirname "$db_file")"
    cp -a "$dest" "$db_file" 2>>"$MAIN_LOG" || {
      log_err "Failed to restore database file to $db_file"
      return 1
    }
    return 0
  fi

  if [[ "$mode" != "dir" ]] || [[ ! -f "$SESSION_DIR/data.tar.gz" ]]; then
    return 0
  fi
  if ! data_dir_is_under_server "$data_dir"; then
    log_err "Refusing to extract tarball into $data_dir (not under server/). Restore manually from $SESSION_DIR/data.tar.gz"
    return 1
  fi
  log "Restoring data directory from backup tarball..."
  rm -rf "$data_dir"
  mkdir -p "$(dirname "$data_dir")"
  tar xzf "$SESSION_DIR/data.tar.gz" -C "$(dirname "$data_dir")" 2>>"$MAIN_LOG" || {
    log_err "Failed to extract data.tar.gz — check archive integrity"
    return 1
  }
  return 0
}

git_revert_hard() {
  local repo="$1" sha="$2"
  [[ -n "$sha" ]] || return 0
  log "Git reset --hard $sha (does not delete untracked files like .env)"
  (cd "$repo" && git reset --hard "$sha") >>"$MAIN_LOG" 2>&1 || log_err "git reset failed — inspect repo manually at $repo"
}

npm_install_server() {
  log "Running npm install in $SERVER_DIR ..."
  (cd "$SERVER_DIR" && npm install) >>"$MAIN_LOG" 2>&1
}

verify_node() {
  log "Verifying Node syntax: src/index.js"
  (cd "$SERVER_DIR" && node --check src/index.js) >>"$MAIN_LOG" 2>&1
}

start_server() {
  if [[ "${APIX_SKIP_SERVICE_START:-}" == "1" ]]; then
    log "Skipping auto-start (APIX_SKIP_SERVICE_START=1). Start with: ./apix.sh → Start, or: sudo systemctl start apix-gateway"
    return 0
  fi
  if systemctl is-enabled apix-gateway &>/dev/null; then
    log "Starting systemd unit apix-gateway..."
    sudo -n systemctl start apix-gateway 2>/dev/null || sudo systemctl start apix-gateway || log_err "Start apix-gateway manually: sudo systemctl start apix-gateway"
  else
    log "No systemd unit detected. Start the server with: cd $SERVER_DIR && ./apix.sh (option 2) or: nohup node src/index.js >> logs/apix.log 2>&1 &"
  fi
}

prune_old_backups() {
  local base="$BACKUP_PARENT"
  [[ -d "$base" ]] || return 0
  # Newest first; drop KEEP_N newest, remove the rest
  local old
  while IFS= read -r old; do
    [[ -z "$old" ]] && continue
    log "Removing old session: $old"
    rm -rf "$old"
  done < <(ls -1td "$base"/*/ 2>/dev/null | tail -n +"$((KEEP_N + 1))")
}

# ── main ───────────────────────────────────────────────────────────
log "======== ApiX safe update session $STAMP ========"
log "Server directory: $SERVER_DIR"
log "Session / logs:   $SESSION_DIR"
log "Error log file:   $ERROR_LOG"

REPO_ROOT=""
if ! REPO_ROOT="$(find_git_root)"; then
  log_err "No Git repository found above $SERVER_DIR."
  log_err "Clone the project first: git clone https://github.com/FOUNDATIONAIBASED/APIX.git && cd APIX/server"
  log_err "All details written to: $ERROR_LOG"
  exit 1
fi
log "Git repository root: $REPO_ROOT"

DATA_DIR="$(resolve_data_dir)"
log "Resolved data directory: $DATA_DIR"

OLD_SHA=""
OLD_SHA="$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null)" || {
  log_err "Could not read current git HEAD"
  log_err "All details written to: $ERROR_LOG"
  exit 1
}
echo "$OLD_SHA" > "$SESSION_DIR/pre_update_commit.txt"
log "Pre-update commit: $OLD_SHA"

stop_server || true

if ! backup_data_dir "$DATA_DIR"; then
  log_err "Backup failed — aborting without changes."
  log_err "See: $ERROR_LOG"
  start_server
  exit 1
fi

backup_server_tree

FAILED=0
if ! cd "$REPO_ROOT"; then
  log_err "Cannot cd to $REPO_ROOT"
  FAILED=1
else
  log "Fetching $GIT_REMOTE ..."
  git fetch "$GIT_REMOTE" >>"$MAIN_LOG" 2>&1 || FAILED=1
  if [[ "$FAILED" -eq 0 ]]; then
    log "Pulling $GIT_REMOTE/$GIT_BRANCH (ff-only) ..."
    git pull --ff-only "$GIT_REMOTE" "$GIT_BRANCH" >>"$MAIN_LOG" 2>&1 || FAILED=1
  fi
fi

if [[ "$FAILED" -ne 0 ]]; then
  if [[ ! -d "$REPO_ROOT" ]] || ! cd "$REPO_ROOT" 2>/dev/null; then
    log_err "Repository unreachable — no git changes applied. Data backup is at $SESSION_DIR/data.tar.gz"
    start_server
    log_err "Full logs: $MAIN_LOG | Errors: $ERROR_LOG"
    exit 1
  fi
  log_err "git fetch/pull failed — reverting repository and restoring data."
  git_revert_hard "$REPO_ROOT" "$OLD_SHA"
  restore_data_dir "$DATA_DIR"
  npm_install_server || true
  verify_node || true
  start_server
  log_err "Update aborted. Full logs: $MAIN_LOG"
  log_err "Error summary: $ERROR_LOG"
  exit 1
fi

NEW_SHA="$(cd "$REPO_ROOT" && git rev-parse HEAD)"
log "Post-pull commit: $NEW_SHA"
echo "$NEW_SHA" > "$SESSION_DIR/post_update_commit.txt"

if ! npm_install_server; then
  log_err "npm install failed — reverting."
  git_revert_hard "$REPO_ROOT" "$OLD_SHA"
  restore_data_dir "$DATA_DIR"
  npm_install_server || true
  start_server
  log_err "Update rolled back. Logs: $MAIN_LOG | Errors: $ERROR_LOG"
  exit 1
fi

if ! verify_node; then
  log_err "node --check failed — reverting."
  git_revert_hard "$REPO_ROOT" "$OLD_SHA"
  restore_data_dir "$DATA_DIR"
  npm_install_server || true
  start_server
  log_err "Update rolled back. Logs: $MAIN_LOG | Errors: $ERROR_LOG"
  exit 1
fi

prune_old_backups
log "======== Update successful ========"
log "If anything looks wrong, your previous commit was: $OLD_SHA (saved in $SESSION_DIR/pre_update_commit.txt)"
start_server

echo ""
echo "  ✔ Update complete."
echo "  📁 Session directory: $SESSION_DIR"
echo "  📄 Full log:          $MAIN_LOG"
echo "  ⚠ If issues occurred, errors are also in: $ERROR_LOG"
echo ""

exit 0
