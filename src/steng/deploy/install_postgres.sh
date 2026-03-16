#!/usr/bin/env bash
set -euo pipefail

install_with_apt() {
  sudo apt-get update
  sudo apt-get install -y postgresql postgresql-contrib libpq-dev
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl enable --now postgresql || true
  fi
}

install_with_dnf() {
  sudo dnf install -y postgresql-server postgresql-contrib postgresql-devel
  if command -v postgresql-setup >/dev/null 2>&1; then
    sudo postgresql-setup --initdb || true
  fi
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl enable --now postgresql || true
  fi
}

install_with_brew() {
  brew install postgresql@16
  echo "PostgreSQL installed with Homebrew. Start it with:"
  echo "  brew services start postgresql@16"
}

if command -v psql >/dev/null 2>&1; then
  echo "psql already installed: $(psql --version)"
  exit 0
fi

if command -v apt-get >/dev/null 2>&1; then
  install_with_apt
elif command -v dnf >/dev/null 2>&1; then
  install_with_dnf
elif command -v brew >/dev/null 2>&1; then
  install_with_brew
else
  echo "Unsupported package manager. Install PostgreSQL server/client/dev packages manually." >&2
  exit 1
fi

psql --version
