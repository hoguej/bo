#!/usr/bin/env bash
# Wrapper to run watch-self with project env. Use with launchd for a daemon + watchdog.
set -e

BO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BO_ROOT"
mkdir -p logs

if [[ -f .env.local ]]; then
  set -a
  source .env.local
  set +a
fi

exec npm run watch-self
