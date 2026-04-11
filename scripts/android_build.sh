#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/android_build.sh <android_deployer|app_tester> [gradle task]

Examples:
  bash scripts/android_build.sh app_tester
  bash scripts/android_build.sh android_deployer :app:assembleRelease
EOF
}

APP_NAME="${1:-}"
TASK="${2:-:app:assembleDebug}"
VERSION_CODE="${NETAB_ANDROID_VERSION_CODE:-}"
VERSION_NAME="${NETAB_ANDROID_VERSION_NAME:-}"

if [[ -z "$APP_NAME" ]]; then
  usage >&2
  exit 1
fi

if [[ ! -x "$HOME/.local/bin/netab-android-env" ]]; then
  echo "Missing $HOME/.local/bin/netab-android-env. Run bash scripts/android_prepare_local.sh first." >&2
  exit 1
fi

case "$APP_NAME" in
  android_deployer | app_tester) ;;
  *)
    echo "Unknown app: $APP_NAME" >&2
    usage >&2
    exit 1
    ;;
esac

# shellcheck source=/dev/null
source "$HOME/.local/bin/netab-android-env"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../apps/$APP_NAME" && pwd)"
cat >"$APP_DIR/local.properties" <<EOF
sdk.dir=$HOME/android/sdk
EOF

cd "$APP_DIR"
GRADLE_ARGS=(--no-daemon)
if [[ -n "$VERSION_CODE" ]]; then
  GRADLE_ARGS+=("-PnetabVersionCode=$VERSION_CODE")
fi
if [[ -n "$VERSION_NAME" ]]; then
  GRADLE_ARGS+=("-PnetabVersionName=$VERSION_NAME")
fi

gradle "${GRADLE_ARGS[@]}" "$TASK"
