#!/usr/bin/env bash
# Pixel Kaisha — run the standalone server on the dev box inside a tmux session.
#
#   scripts/box-run.sh start [--build]   build if needed, start on 127.0.0.1:3100
#   scripts/box-run.sh stop              stop the server (kills the tmux session)
#   scripts/box-run.sh status            tmux + /api/health + tokened URL
#   scripts/box-run.sh restart [--build]
#   scripts/box-run.sh url               print the tokened URL only
#
# Environment overrides: KAISHA_HOST (127.0.0.1), KAISHA_PORT (3100),
# KAISHA_SESSION (kaisha), KAISHA_LOG (~/.pixel-agents/kaisha-server.log),
# KAISHA_EXTRA_ARGS (extra CLI flags, e.g. "--no-terminal"),
# KAISHA_HOOKS_PROJECT_DIR (/workspace/pixel-agents/sandbox; "user" = home configs).
#
# The token is never printed to the log by the server; `status`/`url` read it
# from ~/.pixel-agents/standalone-token and print it to YOUR terminal only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${KAISHA_HOST:-127.0.0.1}"
PORT="${KAISHA_PORT:-3100}"
SESSION="${KAISHA_SESSION:-kaisha}"
STATE_DIR="${HOME}/.pixel-agents"
LOG="${KAISHA_LOG:-${STATE_DIR}/kaisha-server.log}"
TOKEN_FILE="${STATE_DIR}/standalone-token"
EXTRA_ARGS="${KAISHA_EXTRA_ARGS:-}"
# Hooks are installed ONLY in this project (never in ~/.claude, ~/.codex, ~/.gemini).
# Set KAISHA_HOOKS_PROJECT_DIR=user to fall back to user-level hooks (not on the box).
HOOKS_DIR="${KAISHA_HOOKS_PROJECT_DIR:-/workspace/pixel-agents/sandbox}"
HEALTH_URL="http://${HOST}:${PORT}/api/health"

die() { echo "box-run: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }

is_running() { tmux has-session -t "=${SESSION}" 2>/dev/null; }

health() { curl -fsS --max-time 2 "${HEALTH_URL}" 2>/dev/null; }

tokened_url() {
  [[ -s "${TOKEN_FILE}" ]] || return 1
  printf 'http://%s:%s/?token=%s\n' "${HOST}" "${PORT}" "$(tr -d '[:space:]' < "${TOKEN_FILE}")"
}

build() {
  echo "box-run: building (npm run build)…"
  (cd "${ROOT}" && npm run build >/dev/null) || die "build failed (run 'npm run build' to see why)"
}

start() {
  need tmux; need node; need curl
  local force_build="${1:-}"
  if is_running; then
    echo "box-run: already running (tmux session '${SESSION}')."
    status
    return 0
  fi
  if health >/dev/null; then
    die "port ${PORT} already answers /api/health but tmux '${SESSION}' is not running; stop that server first"
  fi
  if [[ "${force_build}" == "--build" || ! -f "${ROOT}/dist/cli.js" || ! -d "${ROOT}/dist/webview" ]]; then
    build
  fi
  mkdir -p "${STATE_DIR}"
  : > "${LOG}"
  # shellcheck disable=SC2086 # EXTRA_ARGS is intentionally word-split
  local hooks_env=""
  [[ "${HOOKS_DIR}" != "user" ]] && hooks_env="PIXEL_KAISHA_HOOKS_PROJECT_DIR='${HOOKS_DIR}' "
  tmux new-session -d -s "${SESSION}" -c "${ROOT}" \
    "${hooks_env}exec node dist/cli.js --host '${HOST}' --port '${PORT}' ${EXTRA_ARGS} >>'${LOG}' 2>&1"
  for _ in $(seq 1 50); do
    if health >/dev/null; then
      echo "box-run: started on ${HOST}:${PORT} (tmux '${SESSION}', log ${LOG})."
      status
      return 0
    fi
    is_running || break
    sleep 0.2
  done
  echo "box-run: server did not become healthy; last log lines:" >&2
  tail -n 20 "${LOG}" >&2 || true
  tmux kill-session -t "=${SESSION}" 2>/dev/null || true
  exit 1
}

stop() {
  if is_running; then
    tmux send-keys -t "=${SESSION}" C-c 2>/dev/null || true
    for _ in $(seq 1 25); do health >/dev/null || break; sleep 0.2; done
    tmux kill-session -t "=${SESSION}" 2>/dev/null || true
    echo "box-run: stopped."
  else
    echo "box-run: not running."
  fi
}

status() {
  local rc=0
  if is_running; then echo "tmux:   session '${SESSION}' running"; else echo "tmux:   session '${SESSION}' not running"; rc=1; fi
  local h
  if h="$(health)"; then echo "health: 200 ${h}"; else echo "health: DOWN (${HEALTH_URL})"; rc=1; fi
  if [[ ${rc} -eq 0 ]]; then
    tokened_url | sed 's/^/url:    /' || echo "url:    (token file not found)"
  fi
  return ${rc}
}

cmd="${1:-status}"; shift || true
case "${cmd}" in
  start) start "${1:-}" ;;
  stop) stop ;;
  restart) stop; start "${1:-}" ;;
  status) status ;;
  url) tokened_url || die "no token yet; start the server once" ;;
  -h|--help|help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command '${cmd}' (start|stop|restart|status|url)" ;;
esac
