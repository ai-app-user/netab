#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/android_publish_live.sh [--skip-build]

Environment overrides:
  NETAB_ANDROID_DEST_ROOT   default: /var/www/html/netab/android
  NETAB_ANDROID_BASE_URL    default: https://debian13.ispot.cc/netab/android
  NETAB_ANDROID_VERSION_CODE default: current UTC epoch seconds
  NETAB_ANDROID_DEPLOYER_CHANNEL default: stable
  NETAB_ANDROID_TESTER_CHANNEL   default: dev
EOF
}

SKIP_BUILD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=1
      shift
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

DEST_ROOT="${NETAB_ANDROID_DEST_ROOT:-/var/www/html/netab/android}"
if [[ -n "${NETAB_ANDROID_BASE_URL:-}" ]]; then
  BASE_URL="$NETAB_ANDROID_BASE_URL"
elif ss -ltn 2>/dev/null | grep -q ':443 '; then
  BASE_URL="https://debian13.ispot.cc/netab/android"
else
  BASE_URL="http://debian13.ispot.cc/netab/android"
fi
VERSION_CODE="${NETAB_ANDROID_VERSION_CODE:-$(date -u +%s)}"
DEPLOYER_CHANNEL="${NETAB_ANDROID_DEPLOYER_CHANNEL:-stable}"
TESTER_CHANNEL="${NETAB_ANDROID_TESTER_CHANNEL:-dev}"
GIT_COMMIT="$(git rev-parse --short HEAD)"
DEPLOYER_VERSION_NAME="${NETAB_ANDROID_DEPLOYER_VERSION_NAME:-0.1.0-${DEPLOYER_CHANNEL}.${VERSION_CODE}}"
TESTER_VERSION_NAME="${NETAB_ANDROID_TESTER_VERSION_NAME:-0.1.0-${TESTER_CHANNEL}.${VERSION_CODE}}"

mkdir -p "$DEST_ROOT"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  NETAB_ANDROID_VERSION_CODE="$VERSION_CODE" NETAB_ANDROID_VERSION_NAME="$DEPLOYER_VERSION_NAME" \
    bash scripts/android_build.sh android_deployer
  NETAB_ANDROID_VERSION_CODE="$VERSION_CODE" NETAB_ANDROID_VERSION_NAME="$TESTER_VERSION_NAME" \
    bash scripts/android_build.sh app_tester
fi

node scripts/android_publish.mjs \
  --app android_deployer \
  --channel "$DEPLOYER_CHANNEL" \
  --apk apps/android_deployer/app/build/outputs/apk/debug/app-debug.apk \
  --dest-root "$DEST_ROOT" \
  --base-url "$BASE_URL" \
  --package-name cc.ispot.netab.androiddeployer \
  --version-code "$VERSION_CODE" \
  --version-name "$DEPLOYER_VERSION_NAME" \
  --git-commit "$GIT_COMMIT"

node scripts/android_publish.mjs \
  --app app_tester \
  --channel "$TESTER_CHANNEL" \
  --apk apps/app_tester/app/build/outputs/apk/debug/app-debug.apk \
  --dest-root "$DEST_ROOT" \
  --base-url "$BASE_URL" \
  --package-name cc.ispot.netab.apptester \
  --version-code "$VERSION_CODE" \
  --version-name "$TESTER_VERSION_NAME" \
  --git-commit "$GIT_COMMIT"

echo
echo "Published Android artifacts to:"
echo "  $DEST_ROOT"
echo "Browser page:"
echo "  $BASE_URL/"
