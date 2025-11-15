-- 002_m3_stream.sql
-- Storage for finalized blocks and PLT transfers

CREATE TABLE IF NOT EXISTS blocks_finalized (
  block_hash   TEXT        PRIMARY KEY,
  network      TEXT        NOT NULL,        -- e.g. "concordium:testnet"
  height       BIGINT      NOT NULL,
  finalized_at TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blocks_finalized_height
  ON blocks_finalized (height DESC);

CREATE INDEX IF NOT EXISTS idx_blocks_finalized_finalized_at
  ON blocks_finalized (finalized_at DESC);

CREATE TABLE IF NOT EXISTS plt_transfers (
  tx_hash       TEXT        NOT NULL,
  event_index   INT         NOT NULL,
  block_hash    TEXT        NOT NULL,
  network       TEXT        NOT NULL,       -- e.g. "concordium:testnet"
  token_id      TEXT        NOT NULL,       -- e.g. "usd:test"
  from_addr     TEXT,
  to_addr       TEXT        NOT NULL,
  amount_minor  NUMERIC(38,0) NOT NULL,     -- integer minor units
  decimals      INT         NOT NULL,       -- e.g. 2
  occurred_at   TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_hash, event_index),
  FOREIGN KEY (block_hash)
    REFERENCES blocks_finalized(block_hash)
    ON DELETE CASCADE
);

-- Helpful indexes for matching
CREATE INDEX IF NOT EXISTS idx_plt_transfers_token_to_amt
  ON plt_transfers (token_id, to_addr, amount_minor);

CREATE INDEX IF NOT EXISTS idx_plt_transfers_occurred_at
  ON plt_transfers (occurred_at DESC);
