import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function setMode(filePath, mode) {
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Windows and restrictive filesystems may not implement POSIX modes.
  }
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  setMode(dir, PRIVATE_DIR_MODE);
}

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "codex-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writePrivateFile(filePath, value) {
  fs.writeFileSync(filePath, value, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  setMode(filePath, PRIVATE_FILE_MODE);
}

// Windows can refuse to replace a file that something else has open — an on-access virus scanner
// or a search indexer opening the target for a moment is enough, and it surfaces as EPERM/EACCES/
// EBUSY rather than as anything the caller could act on. POSIX rename has no such failure mode, so
// this retry is Windows-only: a handful of short waits, after which the error is real and is thrown.
const WINDOWS_RENAME_RETRY_DELAYS_MS = [5, 15, 40, 100];
const WINDOWS_RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {string} from
 * @param {string} to
 * @param {{ platform?: string, renameImpl?: Function, sleepImpl?: Function }} [options]
 */
export function renameReplacing(from, to, options = {}) {
  const renameImpl = options.renameImpl ?? fs.renameSync;
  if ((options.platform ?? process.platform) !== "win32") {
    renameImpl(from, to);
    return;
  }

  const sleepImpl = options.sleepImpl ?? sleepSync;
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameImpl(from, to);
      return;
    } catch (error) {
      if (attempt >= WINDOWS_RENAME_RETRY_DELAYS_MS.length || !WINDOWS_RENAME_RETRY_CODES.has(error?.code)) {
        throw error;
      }
      sleepImpl(WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export function writeJsonFileAtomic(filePath, value) {
  const temporaryFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporaryFile, "wx", PRIVATE_FILE_MODE);
    try {
      try {
        fs.fchmodSync(fd, PRIVATE_FILE_MODE);
      } catch {
        // Windows and restrictive filesystems may not implement POSIX modes.
      }
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameReplacing(temporaryFile, filePath);
    setMode(filePath, PRIVATE_FILE_MODE);
  } catch (error) {
    fs.rmSync(temporaryFile, { force: true });
    throw error;
  }
}

export function removeFileIfExists(filePath) {
  if (!filePath) {
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}
