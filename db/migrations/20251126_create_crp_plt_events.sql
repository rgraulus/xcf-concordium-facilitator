-- db/migrations/20251126_create_crp_plt_events.sql
--
-- Creates the CRP PLT events table used by:
-- - The Concordium PLT stream worker (to persist events)
-- - /v1/crp/plt/search (to query persisted events)
-- - Tools like src/tools/debugPltDb.ts
--
-- If the table already exists, this migration will do nothing.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.tables
    WHERE  table_schema = 'public'
    AND    table_name   = 'crp_plt_events'
  ) THEN
    CREATE TABLE public.crp_plt_events (
      id            BIGSERIAL PRIMARY KEY,
      network       TEXT        NOT NULL,  -- e.g. "concordium:testnet"
      token_id      TEXT        NOT NULL,  -- on-chain PLT token id, e.g. "EUDemo"
      tx_hash       TEXT        NOT NULL,  -- transaction hash (hex string)
      event_index   INTEGER     NOT NULL,  -- index of the event within the tx
      block_hash    TEXT        NOT NULL,  -- containing block hash (hex string)
      block_height  BIGINT      NOT NULL,  -- containing block height
      from_addr     TEXT        NOT NULL,  -- sender address (CCD account or contract)
      to_addr       TEXT        NOT NULL,  -- recipient address
      amount_minor  NUMERIC(30,0) NOT NULL, -- integer amount in minor units (scaled by decimals)
      decimals      INTEGER     NOT NULL,  -- token decimals (e.g. 6 for EUDemo)
      occurred_at   TIMESTAMPTZ NOT NULL,  -- when it happened on-chain (approx/finalized time)
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() -- when we stored it
    );

    -- Helpful indexes for search patterns:
    CREATE INDEX crp_plt_events_token_idx
      ON public.crp_plt_events (network, token_id);

    CREATE INDEX crp_plt_events_block_idx
      ON public.crp_plt_events (block_height DESC);

    CREATE INDEX crp_plt_events_tx_idx
      ON public.crp_plt_events (tx_hash, event_index);

    CREATE INDEX crp_plt_events_addr_idx
      ON public.crp_plt_events (from_addr, to_addr);
  END IF;
END
$$;
