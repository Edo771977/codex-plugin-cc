import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  forgetImportRecordsForSource,
  ledgerPathKey,
  restoreImportRecordsForSource
} from "../plugins/codex/scripts/lib/codex.mjs";

function importRecord(sourcePath, threadId) {
  return {
    source_path: sourcePath,
    content_sha256: `sha-${threadId}`,
    imported_thread_id: threadId,
    imported_at: 1,
    source_modified_at: null
  };
}

function useLedger(t, records) {
  const codexHome = makeTempDir();
  const ledgerPath = path.join(codexHome, "external_agent_session_imports.json");
  fs.writeFileSync(ledgerPath, JSON.stringify({ records, detected_connector_records: [] }, null, 2));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });
  return { codexHome, ledgerPath };
}

const threadIds = (ledgerPath) =>
  JSON.parse(fs.readFileSync(ledgerPath, "utf8")).records.map((record) => record.imported_thread_id);

test("--refresh keeps ledger records that another import adds while it rewrites the ledger", (t) => {
  const { codexHome, ledgerPath } = useLedger(t, [importRecord("/a.jsonl", "thr_a"), importRecord("/b.jsonl", "thr_b")]);

  // Codex imports for another session write the ledger without any lock. Land one of those
  // writes while the refresh is preparing its replacement file.
  const writeFileSync = fs.writeFileSync;
  let interleaved = false;
  t.mock.method(fs, "writeFileSync", (file, ...rest) => {
    if (!interleaved && String(file).startsWith(`${ledgerPath}.tmp-`)) {
      interleaved = true;
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      ledger.records.push(importRecord("/c.jsonl", "thr_c"));
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    }
    return writeFileSync(file, ...rest);
  });

  const result = forgetImportRecordsForSource("/a.jsonl");

  assert.equal(interleaved, true);
  assert.equal(result.removed, 1);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.deepEqual(
    ledger.records.map((record) => record.imported_thread_id),
    ["thr_b", "thr_c"]
  );
  assert.deepEqual(ledger.detected_connector_records, []);
  const backup = JSON.parse(fs.readFileSync(result.backupPath, "utf8"));
  assert.deepEqual(
    backup.records.map((record) => record.imported_thread_id),
    ["thr_a", "thr_b", "thr_c"]
  );
  assert.deepEqual(
    fs.readdirSync(codexHome).filter((name) => name.includes(".tmp-")),
    []
  );
});

test("a failed --refresh puts the removed records back without dropping other updates", (t) => {
  const { ledgerPath } = useLedger(t, [importRecord("/a.jsonl", "thr_a"), importRecord("/b.jsonl", "thr_b")]);
  const forgotten = forgetImportRecordsForSource("/a.jsonl");
  assert.deepEqual(forgotten.removedRecords.map((record) => record.imported_thread_id), ["thr_a"]);

  // Another session imports while the refreshed import is running.
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  ledger.records.push(importRecord("/c.jsonl", "thr_c"));
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  assert.equal(restoreImportRecordsForSource("/a.jsonl", forgotten.removedRecords), true);
  assert.deepEqual(threadIds(ledgerPath), ["thr_b", "thr_c", "thr_a"]);
});

test("restoring import records leaves a record that Codex wrote for the source in place", (t) => {
  const { ledgerPath } = useLedger(t, [importRecord("/a.jsonl", "thr_new")]);

  assert.equal(restoreImportRecordsForSource("/a.jsonl", [importRecord("/a.jsonl", "thr_old")]), false);
  assert.deepEqual(threadIds(ledgerPath), ["thr_new"]);
});

test("ledger paths compare as Codex records them on Windows", () => {
  // Codex canonicalizes with std::fs::canonicalize: an extended-length path on Windows, while
  // Node's realpath gives the plain drive form. Windows paths are case-insensitive too.
  const ours = String.raw`C:\Users\me\.claude\projects\-repo\s.jsonl`;
  assert.equal(ledgerPathKey(String.raw`\\?\C:\Users\Me\.claude\projects\-repo\s.jsonl`, "win32"), ledgerPathKey(ours, "win32"));
  assert.equal(
    ledgerPathKey(String.raw`\\?\UNC\srv\share\s.jsonl`, "win32"),
    ledgerPathKey(String.raw`\\srv\share\S.jsonl`, "win32")
  );
  // Elsewhere a path is compared exactly as written.
  assert.notEqual(ledgerPathKey("/Home/s.jsonl", "linux"), ledgerPathKey("/home/s.jsonl", "linux"));
  assert.equal(ledgerPathKey(undefined, "win32"), null);
});

test("--refresh updates the target of a symlinked ledger and keeps its mode", { skip: process.platform === "win32" }, (t) => {
  const { codexHome, ledgerPath } = useLedger(t, [importRecord("/a.jsonl", "thr_a"), importRecord("/b.jsonl", "thr_b")]);
  // The ledger is a link into a dotfiles directory, readable by its owner only.
  const realLedger = path.join(makeTempDir(), "imports.json");
  fs.renameSync(ledgerPath, realLedger);
  fs.symlinkSync(realLedger, ledgerPath);
  fs.chmodSync(realLedger, 0o600);

  const result = forgetImportRecordsForSource("/a.jsonl");

  assert.equal(result.removed, 1);
  assert.equal(fs.lstatSync(ledgerPath).isSymbolicLink(), true, "the link must stay a link");
  assert.deepEqual(threadIds(realLedger), ["thr_b"]);
  assert.equal(fs.statSync(realLedger).mode & 0o777, 0o600);
  assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(path.dirname(realLedger)).filter((name) => name.includes(".tmp-")),
    []
  );
  assert.ok(fs.existsSync(codexHome));
});

test("two refreshes in the same millisecond keep both backups", (t) => {
  const { ledgerPath } = useLedger(t, [importRecord("/a.jsonl", "thr_a"), importRecord("/b.jsonl", "thr_b")]);
  t.mock.method(Date, "now", () => 1_700_000_000_000);

  const first = forgetImportRecordsForSource("/a.jsonl");
  const second = forgetImportRecordsForSource("/b.jsonl");

  assert.notEqual(first.backupPath, second.backupPath);
  assert.deepEqual(JSON.parse(fs.readFileSync(first.backupPath, "utf8")).records.map((r) => r.imported_thread_id), ["thr_a", "thr_b"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(second.backupPath, "utf8")).records.map((r) => r.imported_thread_id), ["thr_b"]);
  assert.deepEqual(threadIds(ledgerPath), []);
});

test("a ledger read that lands on Codex's half-written file is retried", (t) => {
  const { ledgerPath } = useLedger(t, [importRecord("/a.jsonl", "thr_a"), importRecord("/b.jsonl", "thr_b")]);
  // Codex writes the ledger by truncating and writing it, so a reader can see part of it.
  const readFileSync = fs.readFileSync;
  let truncatedReads = 0;
  t.mock.method(fs, "readFileSync", (file, ...rest) => {
    const content = readFileSync(file, ...rest);
    if (String(file) === fs.realpathSync(ledgerPath) && truncatedReads === 0) {
      truncatedReads += 1;
      return String(content).slice(0, 20);
    }
    return content;
  });

  const result = forgetImportRecordsForSource("/a.jsonl");

  assert.equal(truncatedReads, 1);
  assert.equal(result.removed, 1);
  assert.deepEqual(threadIds(ledgerPath), ["thr_b"]);
});

test("--refresh keeps a readable ledger readable under a restrictive umask", { skip: process.platform === "win32" }, (t) => {
  const { ledgerPath } = useLedger(t, [importRecord("/a.jsonl", "thr_a"), importRecord("/b.jsonl", "thr_b")]);
  fs.chmodSync(ledgerPath, 0o644);
  // A umask of 077 would narrow the replacement to 0600 if it only got the mode at creation.
  const previousUmask = process.umask(0o077);
  t.after(() => process.umask(previousUmask));

  const result = forgetImportRecordsForSource("/a.jsonl");

  assert.equal(fs.statSync(ledgerPath).mode & 0o777, 0o644);
  assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o644);
});
