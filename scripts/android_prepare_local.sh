#!/usr/bin/env bash
set -euo pipefail

ANDROID_BASE="${ANDROID_BASE:-$HOME/android}"
TOOLCHAIN_DIR="$ANDROID_BASE/toolchain"
SDK_DIR="$ANDROID_BASE/sdk"
DOWNLOADS_DIR="$ANDROID_BASE/downloads"
BIN_DIR="$HOME/.local/bin"
JDK_URL="${JDK_URL:-https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse}"
GRADLE_URL="${GRADLE_URL:-https://services.gradle.org/distributions/gradle-8.7-bin.zip}"
CMDLINE_TOOLS_URL="${CMDLINE_TOOLS_URL:-https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip}"

mkdir -p "$TOOLCHAIN_DIR" "$SDK_DIR" "$DOWNLOADS_DIR" "$BIN_DIR"

download_if_missing() {
  local url="$1"
  local output="$2"
  if [[ ! -f "$output" ]]; then
    curl -L --fail -o "$output" "$url"
  fi
}

download_if_missing "$JDK_URL" "$DOWNLOADS_DIR/temurin17.tar.gz"
download_if_missing "$GRADLE_URL" "$DOWNLOADS_DIR/gradle-8.7-bin.zip"
download_if_missing "$CMDLINE_TOOLS_URL" "$DOWNLOADS_DIR/commandlinetools-linux-latest.zip"

python3 - <<'PY'
from pathlib import Path
import shutil
import tarfile
import zipfile

home = Path.home()
base = Path.home() / "android"
downloads = base / "downloads"
toolchain = base / "toolchain"
sdk = base / "sdk"

jdk_tar = downloads / "temurin17.tar.gz"
if not any(toolchain.glob("jdk-17*")):
    with tarfile.open(jdk_tar) as tf:
        tf.extractall(toolchain)

gradle_zip = downloads / "gradle-8.7-bin.zip"
if not (toolchain / "gradle-8.7").exists():
    with zipfile.ZipFile(gradle_zip) as zf:
        zf.extractall(toolchain)

cmd_zip = downloads / "commandlinetools-linux-latest.zip"
latest_dir = sdk / "cmdline-tools" / "latest"
if not latest_dir.exists():
    tmp = sdk / "cmdline-tools" / "__extract_tmp__"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(cmd_zip) as zf:
        zf.extractall(tmp)
    src = tmp / "cmdline-tools"
    latest_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(latest_dir))
    shutil.rmtree(tmp)
PY

chmod +x "$SDK_DIR/cmdline-tools/latest/bin/"* || true
chmod +x "$TOOLCHAIN_DIR/gradle-8.7/bin/gradle" || true

JDK_DIR="$(find "$TOOLCHAIN_DIR" -maxdepth 1 -type d -name 'jdk-17*' | head -n1)"
if [[ -z "$JDK_DIR" ]]; then
  echo "Failed to locate extracted JDK" >&2
  exit 1
fi

cat >"$BIN_DIR/netab-android-env" <<EOF
#!/usr/bin/env bash
export JAVA_HOME="$JDK_DIR"
export ANDROID_HOME="$SDK_DIR"
export ANDROID_SDK_ROOT="$SDK_DIR"
export PATH="$JDK_DIR/bin:$TOOLCHAIN_DIR/gradle-8.7/bin:$SDK_DIR/cmdline-tools/latest/bin:$SDK_DIR/platform-tools:\$PATH"
export GRADLE_OPTS="-Dorg.gradle.jvmargs=-Xmx768m -Dkotlin.daemon.jvm.options=-Xmx384m"
EOF
chmod +x "$BIN_DIR/netab-android-env"

# shellcheck source=/dev/null
source "$BIN_DIR/netab-android-env"
(yes || true) | sdkmanager --sdk_root="$ANDROID_SDK_ROOT" --licenses >/dev/null || true
sdkmanager --sdk_root="$ANDROID_SDK_ROOT" "platform-tools" "platforms;android-35" "build-tools;35.0.0"

echo "Installed rootless Android toolchain."
echo "Source it with: source $BIN_DIR/netab-android-env"
