#!/usr/bin/env bash
set -euo pipefail

if command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 already installed: $(sqlite3 --version)"
  exit 0
fi

if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y sqlite3 libsqlite3-dev
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y sqlite sqlite-devel
elif command -v brew >/dev/null 2>&1; then
  brew install sqlite
else
  echo "Unsupported package manager. Install sqlite3 and SQLite development headers manually." >&2
  exit 1
fi

sqlite3 --version
