#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/android_upload.sh \
    --source-root <local staging dir> \
    --remote <user@host:/absolute/remote/path>

Example:
  bash scripts/android_upload.sh \
    --source-root ./deploy/android/out \
    --remote user@debian13.ispot.cc:/var/www/netab/android
EOF
}

SOURCE_ROOT=""
REMOTE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-root)
      SOURCE_ROOT="${2:-}"
      shift 2
      ;;
    --remote)
      REMOTE="${2:-}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$SOURCE_ROOT" || -z "$REMOTE" ]]; then
  usage >&2
  exit 1
fi

if [[ ! -d "$SOURCE_ROOT" ]]; then
  echo "Source root does not exist: $SOURCE_ROOT" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required for android_upload.sh" >&2
  exit 1
fi

rsync -av "$SOURCE_ROOT"/ "$REMOTE"/
