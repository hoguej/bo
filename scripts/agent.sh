#!/usr/bin/env bash
# Receives the message as first argument; prints the response to stdout.
# This script bypasses Cursor completely and calls Vercel AI Gateway directly.
set -e
msg="${1:-}"
if [[ -z "$msg" ]]; then
  echo "No message provided."
  exit 1
fi

# Project root (parent of scripts/) so router/skills can find config/contacts.json etc.
BO_PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export BO_PROJECT_ROOT
cd "$BO_PROJECT_ROOT"

# We prefer Vercel AI Gateway (GPT-4.*) for responses.
# Auth: AI_GATEWAY_API_KEY (recommended) or VERCEL_OIDC_TOKEN.
gateway_key="${AI_GATEWAY_API_KEY:-}"
if [[ -z "$gateway_key" && -z "${VERCEL_OIDC_TOKEN:-}" ]]; then
  echo "Missing AI Gateway auth. Set AI_GATEWAY_API_KEY (recommended) or VERCEL_OIDC_TOKEN."
  exit 1
fi

# Unified router: decides whether to call a local skill and/or save facts.
AI_GATEWAY_API_KEY="$gateway_key" bun run scripts/router.ts "$msg"
