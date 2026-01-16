-- db/migrations/20251126_create_crp_plt_events.sql
--
-- Canonical CRP PLT schema (M4.2):
--   - crp_plt_assets: network-scoped decimals/enablement registry
--   - crp_plt_events: raw PLT transfer events (amount_raw + asset_id) + JOIN to assets for decimals
--
-- Notes:
-- - This migration is intentionally idempotent (IF NOT EXISTS / migration-in-place).
-- - For local/dev, if you previously had an older schema where crp_plt_assets was keyed only by asset_id,
--   this migration will backfill network scope with defaults:
--     network = 'concordium:testnet'
--     network_genesis_index = 6

-- 1) Asset registry
CREATE TABLE IF NOT EXISTS public.crp_plt_assets (
  network               TEXT    NOT NULL,
  network_genesis_index INTEGER NOT NULL,
  asset_id              TEXT    NOT NULL,
  symbol                TEXT    NOT NULL,
  decimals              INTEGER NOT NULL,
  description           TEXT,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (network, network_genesis_index, asset_id)
);

-- 2) PLT events
CREATE TABLE IF NOT EXISTS public.crp_plt_events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Chain location
  block_hash TEXT NOT NULL,
  block_height BIGINT NOT NULL,
  transaction_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL,

  -- Network / rail
  network TEXT NOT NULL,
  network_genesis_index INTEGER NOT NULL,
  finalized BOOLEAN NOT NULL DEFAULT TRUE,

  -- Semantics
  event_type TEXT NOT NULL,
  from_address TEXT,
  to_address TEXT,

  -- Amount
  amount_raw NUMERIC(38, 0) NOT NULL,
  asset_id TEXT NOT NULL,

  occurred_at TIMESTAMPTZ NOT NULL,

  UNIQUE (transaction_hash, event_index)
);

-- 3) Migrate older schemas (safe no-ops if already current)
ALTER TABLE public.crp_plt_assets
  ADD COLUMN IF NOT EXISTS network               TEXT,
  ADD COLUMN IF NOT EXISTS network_genesis_index INTEGER;

UPDATE public.crp_plt_assets
   SET network = 'concordium:testnet'
 WHERE network IS NULL;

UPDATE public.crp_plt_assets
   SET network_genesis_index = 6
 WHERE network_genesis_index IS NULL;

ALTER TABLE public.crp_plt_assets
  ALTER COLUMN network SET DEFAULT 'concordium:testnet',
  ALTER COLUMN network_genesis_index SET DEFAULT 6,
  ALTER COLUMN network SET NOT NULL,
  ALTER COLUMN network_genesis_index SET NOT NULL;

DO $$
DECLARE
  assets_pk text;
  events_fk text;
  desired_assets_pk text := 'crp_plt_assets_pkey';
  desired_events_fk text := 'crp_plt_events_asset_fk';
BEGIN
  -- Drop legacy FK on events (if any)
  SELECT c.conname INTO events_fk
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'crp_plt_events'
     AND c.contype = 'f';

  IF events_fk IS NOT NULL AND events_fk <> desired_events_fk THEN
    EXECUTE format('ALTER TABLE public.crp_plt_events DROP CONSTRAINT %I', events_fk);
  END IF;

  -- Drop existing PK if it is not our desired composite PK
  SELECT c.conname INTO assets_pk
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'crp_plt_assets'
     AND c.contype = 'p';

  IF assets_pk IS NOT NULL AND assets_pk <> desired_assets_pk THEN
    EXECUTE format('ALTER TABLE public.crp_plt_assets DROP CONSTRAINT %I', assets_pk);
  END IF;

  -- Add desired PK if missing
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'crp_plt_assets'
       AND c.contype = 'p'
       AND c.conname = desired_assets_pk
  ) THEN
    EXECUTE 'ALTER TABLE public.crp_plt_assets ADD CONSTRAINT crp_plt_assets_pkey PRIMARY KEY (network, network_genesis_index, asset_id)';
  END IF;

  -- Add desired FK if missing
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'crp_plt_events'
       AND c.contype = 'f'
       AND c.conname = desired_events_fk
  ) THEN
    EXECUTE '
      ALTER TABLE public.crp_plt_events
        ADD CONSTRAINT crp_plt_events_asset_fk
        FOREIGN KEY (network, network_genesis_index, asset_id)
        REFERENCES public.crp_plt_assets (network, network_genesis_index, asset_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
    ';
  END IF;
END $$;

-- 4) Indexes
CREATE INDEX IF NOT EXISTS crp_plt_events_block_height_idx
  ON public.crp_plt_events (block_height);

CREATE INDEX IF NOT EXISTS crp_plt_events_tx_hash_idx
  ON public.crp_plt_events (transaction_hash);

CREATE INDEX IF NOT EXISTS crp_plt_events_to_addr_amount_idx
  ON public.crp_plt_events (to_address, asset_id, amount_raw);

CREATE INDEX IF NOT EXISTS crp_plt_events_network_height_idx
  ON public.crp_plt_events (network, block_height);

CREATE INDEX IF NOT EXISTS crp_plt_events_network_asset_idx
  ON public.crp_plt_events (network, network_genesis_index, asset_id);

CREATE INDEX IF NOT EXISTS crp_plt_assets_enabled_idx
  ON public.crp_plt_assets (network, network_genesis_index, enabled);
