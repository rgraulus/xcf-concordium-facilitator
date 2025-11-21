#!/usr/bin/env bash
set -euo pipefail

# Resolve repo root (one level up from scripts/)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Configure the CRP stream worker to use the Concordium source in dry-run mode.
# - CRP_STREAM_SOURCE=concordium  -> use ConcordiumPltEventSource
# - CRP_STREAM_DRY_RUN=1         -> don't write to DB, just log what would happen
# - CRP_STREAM_MAX_TICKS=2       -> exit after a small number of polling cycles
#
# Other stream-related env vars (like network, tokenId, poll interval) will use
# their defaults from the worker config if you don't override them here.

export CRP_STREAM_SOURCE="${CRP_STREAM_SOURCE:-concordium}"
export CRP_STREAM_DRY_RUN="${CRP_STREAM_DRY_RUN:-1}"
export CRP_STREAM_MAX_TICKS="${CRP_STREAM_MAX_TICKS:-2}"

echo "== CRP Concordium PLT Stream (dry-run) =="
echo "  CRP_STREAM_SOURCE     = ${CRP_STREAM_SOURCE}"
echo "  CRP_STREAM_DRY_RUN    = ${CRP_STREAM_DRY_RUN}"
echo "  CRP_STREAM_MAX_TICKS  = ${CRP_STREAM_MAX_TICKS}"
echo

# Run the worker demo entrypoint via npm
cd "$REPO_ROOT"
npm run crp:worker:demo
