-- Create the main table
CREATE TABLE IF NOT EXISTS token_transfers (
    transaction_hash TEXT PRIMARY KEY,
    block_number BIGINT NOT NULL,
    token_address TEXT NOT NULL,
    sender TEXT NOT NULL,
    receiver TEXT NOT NULL,
    value TEXT NOT NULL,
    chain_id INTEGER NOT NULL DEFAULT 1
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_sender ON token_transfers(sender);
CREATE INDEX IF NOT EXISTS idx_receiver ON token_transfers(receiver);
CREATE INDEX IF NOT EXISTS idx_block ON token_transfers(block_number);
CREATE INDEX IF NOT EXISTS idx_chain_id ON token_transfers(chain_id);