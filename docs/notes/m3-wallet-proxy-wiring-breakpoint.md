# Breakpoint: feat/m3-wallet-proxy-wiring

## Working (confirmed)
- testnet node gRPC v2 reachable on localhost:20001
- transaction-logger ingest running; summaries MAX(height) increases over time
- wallet-proxy container runs; /v0/health responds (but may show healthy=false during catch-up)

## Known issues / risks
- wallet-proxy /v0/health healthy=false with "last final block too old" while node catch-up is still progressing
- canonical DB schema is now: crp_plt_assets + crp_plt_events (transaction_hash, asset_id, amount_raw, network_genesis_index, etc.)
- worker source still uses heuristics and amountRaw="0" placeholder (needs real PLT event parsing later)

## Changes in this branch
- infra/testnet-ingest.yaml: exposed port 10001
- infra/wallet-proxy/: wallet-proxy compose + IP metadata jsons
- src/: updated route/store/migration/worker to canonical schema shape

## Safe breakpoint rule
Do NOT run the demo worker expecting real PLT amounts until extraction is implemented (amountRaw currently "0").
