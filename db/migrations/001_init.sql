-- XCF initial schema: challenges, receipts, webhook_outbox
CREATE TYPE xcf_status AS ENUM ('pending','fulfilled','expired','invalid','policy_failed');

CREATE TABLE IF NOT EXISTS challenges (
  merchant_id    TEXT        NOT NULL,
  nonce          TEXT        NOT NULL,
  network        TEXT        NOT NULL,     -- e.g., concordium:testnet
  asset          JSONB       NOT NULL,     -- {type:"PLT",tokenId,decimals}
  amount         TEXT        NOT NULL,     -- major units as string
  pay_to         TEXT        NOT NULL,     -- recipient address
  expiry         TIMESTAMPTZ NOT NULL,
  policy         JSONB,
  metadata       JSONB,
  status         xcf_status  NOT NULL DEFAULT 'pending',
  receipt        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, nonce)
);

CREATE TABLE IF NOT EXISTS receipts (
  merchant_id    TEXT        NOT NULL,
  nonce          TEXT        NOT NULL,
  jws            TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, nonce),
  FOREIGN KEY (merchant_id, nonce)
    REFERENCES challenges(merchant_id, nonce)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id             BIGSERIAL   PRIMARY KEY,
  merchant_id    TEXT        NOT NULL,
  nonce          TEXT        NOT NULL,
  url            TEXT        NOT NULL,
  body           JSONB       NOT NULL,
  attempts       INT         NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);
CREATE INDEX IF NOT EXISTS idx_challenges_expiry ON challenges(expiry);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON webhook_outbox(created_at);

-- Touch updated_at automatically
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_updated ON challenges;
CREATE TRIGGER trg_touch_updated
BEFORE UPDATE ON challenges
FOR EACH ROW
EXECUTE PROCEDURE touch_updated_at();
