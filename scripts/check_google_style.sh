#!/bin/bash
#
# Check repository source files against the project's Google-style setup.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_JAVA_HOME="${JAVA_HOME:-$HOME/android/toolchain/jdk-17.0.18+8}"

if [[ -x "${LOCAL_JAVA_HOME}/bin/java" ]]; then
  export JAVA_HOME="${LOCAL_JAVA_HOME}"
  export PATH="${JAVA_HOME}/bin:${PATH}"
fi

npx prettier --check \
  "${ROOT_DIR}/package.json" \
  "${ROOT_DIR}/typedoc.json" \
  "${ROOT_DIR}/docs/**/*.md" \
  "${ROOT_DIR}/src/**/*.ts" \
  "${ROOT_DIR}/tests/**/*.ts" \
  "${ROOT_DIR}/apps/**/*.json"

"${ROOT_DIR}/tools/google-style/bin/shfmt" -d -i 2 -ci \
  "${ROOT_DIR}/scripts/android_build.sh" \
  "${ROOT_DIR}/scripts/android_prepare_local.sh" \
  "${ROOT_DIR}/scripts/android_publish_live.sh" \
  "${ROOT_DIR}/scripts/android_upload.sh" \
  "${ROOT_DIR}/scripts/coord" \
  "${ROOT_DIR}/scripts/check_google_style.sh" \
  "${ROOT_DIR}/scripts/format_google_style.sh" \
  "${ROOT_DIR}/src/steng/deploy/init_postgres_steng.sh" \
  "${ROOT_DIR}/src/steng/deploy/install_postgres.sh" \
  "${ROOT_DIR}/src/steng/deploy/install_sqlite.sh"

find "${ROOT_DIR}/apps" \
  -path '*/build/*' -prune -o \
  \( -name '*.kt' -o -name '*.kts' \) -print0 |
  xargs -0 "${ROOT_DIR}/tools/google-style/bin/ktlint"
