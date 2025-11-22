#!/usr/bin/env bash
set -euo pipefail

# Resolve repo root (one level up from scripts/)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Configure the CRP stream worker to use the Concordium source
# and actually WRITE events to Postgres (dryRun=0).
#
# Notes:
#   - CRP_STREAM_SOURCE=concordium   -> use ConcordiumPltEventSource
#   - CRP_STREAM_DRY_RUN=0          -> persist events to DB
#   - CRP_STREAM_MAX_TICKS=5        -> run a few polling cycles then exit
#
# Other stream-related env vars (like network, tokenId, poll interval)
# will use their defaults from the worker config unless overridden.

export CRP_STREAM_SOURCE="${CRP_STREAM_SOURCE:-concordium}"
export CRP_STREAM_DRY_RUN="${CRP_STREAM_DRY_RUN:-0}"
export CRP_STREAM_MAX_TICKS="${CRP_STREAM_MAX_TICKS:-5}"

echo "== CRP Concordium PLT Stream (WRITE MODE) =="
echo "  CRP_STREAM_SOURCE     = ${CRP_STREAM_SOURCE}"
echo "  CRP_STREAM_DRY_RUN    = ${CRP_STREAM_DRY_RUN}"
echo "  CRP_STREAM_MAX_TICKS  = ${CRP_STREAM_MAX_TICKS}"
echo

# Run the worker demo entrypoint via npm
cd "$REPO_ROOT"
npm run crp:worker:demo
