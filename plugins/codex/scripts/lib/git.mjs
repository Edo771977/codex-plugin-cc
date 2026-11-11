import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

// Print non-ASCII paths as they are; with the default core.quotePath, git shows café.js as
// "caf\303\251.js", which neither matches the file on disk nor reads well in a prompt.
const GIT_CONFIG_ARGS = ["-c", "core.quotePath=false"];

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", [...GIT_CONFIG_ARGS, ...args], { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", [...GIT_CONFIG_ARGS, ...args], { cwd, ...options, shell: false });
}

// NUL-separated output keeps every file name intact, whatever characters it contains.
function listFilesZ(cwd, args) {
  return String(gitChecked(cwd, [...args, "-z"]).stdout).split("\0").filter(Boolean);
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const headCommit = gitChecked(cwd, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]).stdout.trim();
  const baseCommit = gitChecked(cwd, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]).stdout.trim();
  const mergeBase = gitChecked(cwd, ["merge-base", headCommit, baseCommit]).stdout.trim();
  return {
    headCommit,
    mergeBase,
    commitRange: `${mergeBase}..${headCommit}`,
    reviewRange: `${baseCommit}...${headCommit}`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = listFilesZ(cwd, ["diff", "--cached", "--name-only"]);
  const unstaged = listFilesZ(cwd, ["diff", "--name-only"]);
  const untracked = listFilesZ(cwd, ["ls-files", "--others", "--exclude-standard"]);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  // Keep leading spaces: `git status --short` puts the index column first, and it is often blank.
  const text = String(body ?? "").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
  return [`## ${title}`, "", text.trim() ? text : "(none)", ""].join("\n");
}

/** The real path of an open descriptor where the system can say (Linux), or null. */
function openedFilePath(fd) {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Read a regular file without following a symlink out of `rootDir`, or say why it was skipped.
 *
 * The lstat check before this runs is a separate step: between it and the read, the file — or a
 * directory above it — can be replaced by a symlink to something outside the repository, and a
 * plain readFileSync would follow it into the review prompt. So:
 * - O_NOFOLLOW refuses a symlink in the last component at open;
 * - the file that was actually opened must still lie inside `rootDir`, which catches a directory
 *   above it swapped for a link (read from the descriptor itself on Linux; elsewhere from the
 *   path's realpath, which narrows that window without closing it);
 * - O_NONBLOCK keeps a FIFO swapped in from blocking the open forever;
 * - the descriptor that was checked is the one read, and never past `maxBytes`, even if the file
 *   grows after the size check.
 * Windows has no O_NOFOLLOW or O_NONBLOCK; there the lstat check and the containment check apply.
 */
export function readRegularFileNoFollow(absolutePath, maxBytes, rootDir = null) {
  let fd;
  try {
    fd = fs.openSync(
      absolutePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
    );
  } catch (error) {
    return { skipped: error?.code === "ELOOP" ? "symlink" : "unreadable file" };
  }
  try {
    if (rootDir) {
      const opened = openedFilePath(fd) ?? fs.realpathSync(absolutePath);
      if (!isInside(fs.realpathSync(rootDir), opened)) {
        return { skipped: "outside the repository" };
      }
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return { skipped: "not a regular file" };
    }
    if (stat.size > maxBytes) {
      return { skipped: `${stat.size} bytes exceeds ${maxBytes} byte limit` };
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) {
        break;
      }
      length += read;
    }
    if (length > maxBytes) {
      return { skipped: `grew past the ${maxBytes} byte limit while being read` };
    }
    return { buffer: buffer.subarray(0, length) };
  } catch {
    return { skipped: "unreadable file" };
  } finally {
    fs.closeSync(fd);
  }
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    // lstat: a symlink's target can live outside the repository, so never follow it.
    stat = fs.lstatSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable file)`;
  }
  if (stat.isSymbolicLink()) {
    return `### ${relativePath}\n(skipped: symlink)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (!stat.isFile()) {
    return `### ${relativePath}\n(skipped: not a regular file)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  const read = readRegularFileNoFollow(absolutePath, MAX_UNTRACKED_BYTES, cwd);
  if (read.skipped) {
    return `### ${relativePath}\n(skipped: ${read.skipped})`;
  }
  const buffer = read.buffer;
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trimEnd();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = options.currentBranch ?? getCurrentBranch(cwd);
  const changedFiles = listFilesZ(cwd, ["diff", "--name-only", comparison.commitRange]);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  const pinnedRange = options.comparison
    ? ` For this branch review, use the pinned commit range ${options.comparison.commitRange}. Read surrounding file content with \`git show ${options.comparison.headCommit}:<path>\`; the working tree may belong to a different branch.`
    : "";
  if (options.includeDiff !== false) {
    return `Use the repository context below as primary evidence.${pinnedRange}`;
  }

  return `The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.${pinnedRange}`;
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = listFilesZ(repoRoot, ["diff", "--name-only", comparison.commitRange]).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison, currentBranch });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff, comparison: details.comparison }),
    ...details
  };
}
