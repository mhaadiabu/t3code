// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import {
  listOpenCodeDatabaseFiles,
  readOpenCodeRecords,
  statOpenCodeDatabase,
} from "./opencodeTranscriptReader.ts";

let dataDir: string;
let database: NodeSqlite.DatabaseSync;

const messageData = (overrides: {
  role?: string;
  input?: number;
  output?: number;
  modelID?: string;
}) =>
  JSON.stringify({
    role: overrides.role ?? "assistant",
    cost: 0.01,
    tokens:
      "input" in overrides || "output" in overrides
        ? {
            input: overrides.input ?? 0,
            output: overrides.output ?? 0,
            reasoning: 0,
            cache: { write: 0, read: 0 },
          }
        : undefined,
    modelID: overrides.modelID ?? "claude-fable-5",
    providerID: "anthropic",
    time: { created: 1_780_114_618_934 },
  });

beforeAll(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode-usage-"));
  database = new NodeSqlite.DatabaseSync(NodePath.join(dataDir, "opencode.db"));
  database.exec(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)",
  );
  database
    .prepare("INSERT INTO message VALUES (?, ?, ?)")
    .run("msg_1", "ses_a", messageData({ input: 100, output: 20 }));
  // User rows carry no tokens and must never surface.
  database
    .prepare("INSERT INTO message VALUES (?, ?, ?)")
    .run("msg_2", "ses_a", messageData({ role: "user" }));
  database
    .prepare("INSERT INTO message VALUES (?, ?, ?)")
    .run("msg_3", "ses_b", messageData({ output: 5 }));
  // A malformed payload must cost its own row, never the whole scan.
  database.prepare("INSERT INTO message VALUES (?, ?, ?)").run("msg_4", "ses_c", "not json {");
});

afterAll(() => {
  database.close();
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

describe("statOpenCodeDatabase", () => {
  it("reports the database as one pseudo-file", () => {
    const file = statOpenCodeDatabase(dataDir);

    expect(file?.path).toBe(NodePath.join(dataDir, "opencode.db"));
    expect(file?.size).toBeGreaterThan(0);
    expect(file?.mtimeMs).toBeGreaterThan(0);
  });

  it("returns null when there is no database", () => {
    expect(statOpenCodeDatabase(NodePath.join(dataDir, "absent"))).toBeNull();
  });
});

describe("listOpenCodeDatabaseFiles", () => {
  it("applies the same mtime window as the transcript walk", () => {
    expect(listOpenCodeDatabaseFiles(dataDir, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(listOpenCodeDatabaseFiles(dataDir, 0)).toHaveLength(1);
  });
});

describe("readOpenCodeRecords", () => {
  it("reads every billable assistant row and nothing else", async () => {
    const records = await readOpenCodeRecords(NodePath.join(dataDir, "opencode.db"));

    expect(records?.length).toBe(2);
    expect(records?.map((record) => record.sessionId)).toEqual(["ses_a", "ses_b"]);
    expect(records?.[0]?.totals).toMatchObject({ uncachedInputTokens: 100, outputTokens: 20 });
  });

  it("returns null for an unreadable store", async () => {
    expect(await readOpenCodeRecords(NodePath.join(dataDir, "absent", "opencode.db"))).toBeNull();
  });
});
