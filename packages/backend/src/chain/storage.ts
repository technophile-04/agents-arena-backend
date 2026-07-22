import { sql } from 'drizzle-orm';

import type { ArenaDatabase } from '../db/index.js';

export function ensureChainTables(database: ArenaDatabase): void {
  database.run(sql`
    CREATE TABLE IF NOT EXISTS wallets (
      run_id TEXT NOT NULL,
      entrant_id TEXT NOT NULL,
      address TEXT NOT NULL,
      private_key TEXT NOT NULL
    )
  `);
  database.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS wallets_run_id_entrant_id
    ON wallets (run_id, entrant_id)
  `);

  database.run(sql`
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      entrant_id TEXT NOT NULL,
      entrant_address TEXT NOT NULL,
      challenge_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      block_number INTEGER NOT NULL
    )
  `);
  database.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS scores_run_id_address_challenge_id
    ON scores (run_id, entrant_address, challenge_id)
  `);
  database.run(sql`
    CREATE INDEX IF NOT EXISTS scores_run_id_entrant_id
    ON scores (run_id, entrant_id)
  `);

  database.run(sql`
    CREATE TABLE IF NOT EXISTS chain_cursors (
      run_id TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      last_processed_block INTEGER NOT NULL
    )
  `);
  database.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS chain_cursors_run_id_contract_address
    ON chain_cursors (run_id, contract_address)
  `);
}
