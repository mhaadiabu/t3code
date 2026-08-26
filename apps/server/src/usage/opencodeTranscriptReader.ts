// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw access to OpenCode's sqlite session store.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`,
 * following the same split as `usageTranscriptReader`. OpenCode keeps every
 * message in one database (`opencode.db` plus its `-wal`/`-shm` siblings), so
 * instead of walking a directory of transcripts we treat the database as a
 * single pseudo-file and stream rows out of it.
 *
 * The connection is opened read-only. OpenCode runs in WAL mode, so a
 * concurrent server never blocks us and we never checkpoint on top of it.
 *
 * @module opencodeTranscriptReader
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { parseOpenCodeMessage, type UsageRecord } from "./usageTranscripts.ts";

export const OPENCODE_DB_FILENAME = "opencode.db";

export interface OpenCodeDatabaseFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Stats the database as one cacheable unit.
 *
 * The scan cache keys parsed records by `(size, mtime)`, but a live OpenCode
 * process writes recent messages into `-wal` without touching the main file,
 * so all three siblings contribute to both figures. Returns `null` when the
 * database itself is absent, which callers report as a missing source.
 */
export function statOpenCodeDatabase(dataDir: string): OpenCodeDatabaseFile | null {
  const dbPath = NodePath.join(dataDir, OPENCODE_DB_FILENAME);
  let size = 0;
  let mtimeMs = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const stats = NodeFS.statSync(dbPath + suffix);
      size += stats.size;
      mtimeMs = Math.max(mtimeMs, stats.mtimeMs);
    } catch {
      // The main file must exist; wal/shm are optional between checkpoints.
      if (suffix === "") return null;
    }
  }
  return { path: dbPath, size, mtimeMs };
}

/** Same mtime gate the transcript walk applies, so windows behave identically. */
export function listOpenCodeDatabaseFiles(
  dataDir: string,
  sinceMs: number,
): readonly OpenCodeDatabaseFile[] {
  const file = statOpenCodeDatabase(dataDir);
  if (file === null || file.mtimeMs < sinceMs) return [];
  return [file];
}

/**
 * Reads every billable assistant message out of the database.
 *
 * Async signature keeps it interchangeable with the transcript reader behind
 * `Effect.promise`, though the work itself is synchronous.
 *
 * Returns `null` when the database could not be opened or read; like the
 * transcript reader, the distinction matters because only a genuinely empty
 * store may be memoised under its `(size, mtime)` key.
 */
export async function readOpenCodeRecords(dbPath: string): Promise<readonly UsageRecord[] | null> {
  const records: UsageRecord[] = [];

  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  try {
    // JSON1 extraction prunes user messages and error stubs before their
    // (potentially large) `data` payloads reach JavaScript. json_valid guards
    // the extraction: a malformed row must cost itself, not throw out of the
    // iterator and void the whole scan.
    const statement = database.prepare(
      `SELECT session_id, data FROM message
       WHERE json_valid(data)
         AND json_extract(data, '$.role') = 'assistant'
         AND json_extract(data, '$.tokens') IS NOT NULL`,
    );
    let scanned = 0;
    for (const row of statement.iterate()) {
      try {
        const record = parseOpenCodeMessage(JSON.parse(String(row.data)), String(row.session_id));
        if (record !== null) records.push(record);
      } catch {
        // A malformed row drops itself rather than failing the scan.
      }
      // The sqlite iteration is fully synchronous, unlike the readline walk
      // over JSONL transcripts. Yield periodically so a cold scan of a large
      // store cannot stall the server's other requests.
      if (++scanned % 2048 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch {
    return null;
  } finally {
    database.close();
  }

  return records;
}
