/**
 * S01-01 — migration runner library.
 *
 * Applies db/migrations/*.sql in lexical order, recording each applied file in
 * `schema_migrations` (with a sha256 checksum guard). Reused by the CLI
 * (scripts/migrate.ts) and the db test suite, which runs it against freshly
 * created scratch databases.
 *
 * Runs must be clean from an EMPTY database (S01-01 AC) and idempotent:
 * applying again is a no-op.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import pg from "pg";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "db",
  "migrations",
);

export async function listMigrationFiles(): Promise<Array<string>> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return files;
}

/** Applies all pending migrations; every file is exactly one transaction. */
export async function migrateDatabase(connectionString: string): Promise<number> {
  const files = await listMigrationFiles();
  // A Pool, not a Client: pool.connect() leases a dedicated session for each
  // BEGIN/COMMIT unit, while the estimating client handles book-keeping.
  const pool = new pg.Pool({ connectionString, max: 2 });
  const book = await pool.connect();
  try {
    // The book-keeping table lives outside migrations so 0001 never has to.
    await book.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    let applied = 0;
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = await book.query<{ filename: string; checksum: string }>(
        "SELECT filename, checksum FROM schema_migrations WHERE filename = $1",
        [file],
      );
      if (prior.rows.length > 0) {
        // An applied file must still be the file that was applied: a hash
        // mismatch means the schema is NOT what the file describes and the
        // run must stop loudly instead of silently continuing.
        if (prior.rows[0]!.checksum !== checksum) {
          throw new Error(
            `migration ${file} has changed since it was applied — checksum mismatch ` +
              `(stored ${prior.rows[0]!.checksum.slice(0, 12)}, file ${checksum.slice(0, 12)}). ` +
              `Revert the file or write a new forward migration.`,
          );
        }
        continue;
      }
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        await tx.query(sql);
        await tx.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [file, checksum],
        );
        await tx.query("COMMIT");
        applied++;
      } catch (error) {
        await tx.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(error as Error).message}`);
      } finally {
        tx.release();
      }
    }
    return applied;
  } finally {
    book.release();
    await pool.end();
  }
}
