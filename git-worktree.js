// git-worktree.js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// Per-project mutex map for worktree operations
const projectLocks = new Map();

/**
 * Acquire a lock for worktree operations on a project
 * @param {string} projectId - Project ID
 * @param {number} timeout - Timeout in ms (default 30000)
 * @returns {Promise<() => void>} - Release function
 */
async function acquireProjectLock(projectId, timeout = 30000) {
  const startTime = Date.now();

  while (projectLocks.has(projectId)) {
    if (Date.now() - startTime > timeout) {
      throw new Error('Timeout waiting for project lock');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  let releaseFn;
  const lockPromise = new Promise(resolve => { releaseFn = resolve; });
  projectLocks.set(projectId, lockPromise);

  return () => {
    projectLocks.delete(projectId);
    releaseFn();
  };
}

/**
 * Convert session name to branch-safe format (deterministic)
 * @param {string} sessionName - Display name of session
 * @returns {string} - Sanitized branch name
 */
export function sanitizeBranchName(sessionName) {
  let result = sessionName
    // Normalize unicode (é → e + combining accent, then remove combining marks)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Remove remaining non-ASCII characters (emoji, etc)
    .replace(/[^\x00-\x7F]/g, '')
    // Replace non-alphanumeric with hyphens
    .replace(/[^a-z0-9]+/g, '-')
    // Collapse multiple hyphens
    .replace(/-+/g, '-')
    // Trim leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    // Truncate to 50 chars
    .slice(0, 50)
    // Trim again after truncation (might end with hyphen)
    .replace(/-+$/g, '');

  return result || 'session';
}

/**
 * Check if directory is a valid git repository (not bare, has commits)
 * @param {string} dir - Directory to check
 * @returns {Promise<{valid: boolean, code?: string, message?: string}>}
 */
export async function validateGitRepo(dir) {
  // Check if it's a git repo
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: dir });
  } catch {
    return {
      valid: false,
      code: 'NOT_GIT_REPO',
      message: 'Directory is not a git repository',
    };
  }

  // Check if it's bare
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--is-bare-repository'],
      { cwd: dir }
    );
    if (stdout.trim() === 'true') {
      return {
        valid: false,
        code: 'BARE_REPO',
        message: 'Bare repositories are not supported',
      };
    }
  } catch {
    return {
      valid: false,
      code: 'NOT_GIT_REPO',
      message: 'Directory is not a git repository',
    };
  }

  // Check if HEAD exists (has commits)
  try {
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
  } catch {
    return {
      valid: false,
      code: 'EMPTY_REPO',
      message: 'Repository has no commits. Make an initial commit first.',
    };
  }

  return { valid: true };
}

/**
 * Validate that .worktrees directory is safe (not a symlink, is a directory or doesn't exist)
 * @param {string} projectDir - Project root directory
 * @returns {Promise<{valid: boolean, message?: string}>}
 */
/**
 * Resolve and validate a worktree path within .worktrees
 * @param {string} projectDir - Project root directory
 * @param {string} worktreePath - Relative worktree path (e.g., ".worktrees/branch-name")
 * @returns {Promise<string>} - Absolute resolved path
 * @throws {Error} with code INVALID_WORKTREE_PATH if path is invalid
 */
export async function resolveWorktreePath(projectDir, worktreePath) {
  if (!worktreePath || typeof worktreePath !== 'string') {
    const err = new Error('Invalid worktree path');
    err.code = 'INVALID_WORKTREE_PATH';
    throw err;
  }

  // Reject absolute paths
  if (path.isAbsolute(worktreePath)) {
    const err = new Error('Worktree path must be relative');
    err.code = 'INVALID_WORKTREE_PATH';
    throw err;
  }

  // Reject path traversal
  const normalized = path.normalize(worktreePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    const err = new Error('Worktree path contains path traversal');
    err.code = 'INVALID_WORKTREE_PATH';
    throw err;
  }

  // Must be under .worktrees/
  if (!normalized.startsWith(`.worktrees${path.sep}`) && normalized !== '.worktrees') {
    const err = new Error('Worktree path must be under .worktrees/');
    err.code = 'INVALID_WORKTREE_PATH';
    throw err;
  }

  // Validate .worktrees directory safety
  const dirValidation = await validateWorktreesDir(projectDir);
  if (!dirValidation.valid) {
    const err = new Error(dirValidation.message);
    err.code = 'PATH_SAFETY_VIOLATION';
    throw err;
  }

  // Resolve both paths consistently - use realpath for projectDir to handle symlinks (e.g., /var -> /private/var on macOS)
  const resolvedProject = await fs.promises.realpath(projectDir).catch(() => path.resolve(projectDir));
  const resolvedTarget = path.resolve(resolvedProject, normalized);

  // Verify the resolved path is inside the project
  if (!resolvedTarget.startsWith(resolvedProject + path.sep)) {
    const err = new Error('Worktree path escapes project directory');
    err.code = 'INVALID_WORKTREE_PATH';
    throw err;
  }

  return resolvedTarget;
}

export async function validateWorktreesDir(projectDir) {
  const worktreesPath = path.join(projectDir, '.worktrees');

  try {
    const lstat = await fs.promises.lstat(worktreesPath);

    if (lstat.isSymbolicLink()) {
      return {
        valid: false,
        message: 'Security violation: .worktrees is a symlink',
      };
    }

    if (!lstat.isDirectory()) {
      return {
        valid: false,
        message: '.worktrees exists but is not a directory',
      };
    }

    // Verify it resolves inside the project
    const resolved = await fs.promises.realpath(worktreesPath);
    const resolvedProject = await fs.promises.realpath(projectDir);
    // Use path.sep suffix to prevent prefix bypass (e.g., /repo/.worktrees vs /repo/.worktrees-evil)
    if (!resolved.startsWith(resolvedProject + path.sep) && resolved !== resolvedProject) {
      return {
        valid: false,
        message: 'Security violation: .worktrees resolves outside project',
      };
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Doesn't exist yet, that's fine
      return { valid: true };
    }
    return {
      valid: false,
      message: `Cannot verify .worktrees: ${err.message}`,
    };
  }

  return { valid: true };
}

/**
 * Validate branch name for safety (no path traversal, valid ref format)
 * @param {string} branchName - Branch name to validate
 * @returns {Promise<{valid: boolean, code?: string}>}
 */
async function validateBranchName(branchName) {
  // Reject path traversal
  if (branchName.includes('..') || branchName.includes('/') || branchName.includes('\\')) {
    return { valid: false, code: 'INVALID_BRANCH_NAME' };
  }

  // Validate with git check-ref-format using refs/heads/ prefix
  // Note: --branch flag doesn't accept -- separator, so we use the full ref path
  try {
    await execFileAsync('git', [
      'check-ref-format',
      `refs/heads/claude/${branchName}`,
    ]);
    return { valid: true };
  } catch {
    return { valid: false, code: 'INVALID_BRANCH_NAME' };
  }
}

/**
 * Create worktree and branch (with path/ref safety checks and mutex)
 * @param {string} projectDir - Project root directory
 * @param {string} branchName - Sanitized branch name (without claude/ prefix)
 * @param {string} projectId - Project ID for mutex
 * @returns {Promise<void>}
 * @throws {Error} with code property for specific errors
 */
export async function createWorktree(projectDir, branchName, projectId) {
  // Validate branch name
  const branchValidation = await validateBranchName(branchName);
  if (!branchValidation.valid) {
    const err = new Error(`Invalid branch name: ${branchName}`);
    err.code = branchValidation.code;
    throw err;
  }

  // Validate .worktrees directory (path safety)
  const dirValidation = await validateWorktreesDir(projectDir);
  if (!dirValidation.valid) {
    const err = new Error(dirValidation.message);
    err.code = 'PATH_SAFETY_VIOLATION';
    throw err;
  }

  // Acquire project lock
  const release = await acquireProjectLock(projectId);

  try {
    const worktreePath = path.join(projectDir, '.worktrees', branchName);
    const fullBranchName = `claude/${branchName}`;

    // Ensure .worktrees directory exists
    const worktreesDir = path.join(projectDir, '.worktrees');
    await fs.promises.mkdir(worktreesDir, { recursive: true });

    // Create worktree with new branch
    try {
      await execFileAsync(
        'git',
        ['worktree', 'add', '-b', fullBranchName, '--', worktreePath],
        { cwd: projectDir }
      );
    } catch (err) {
      const error = new Error(`Failed to create worktree: ${err.stderr || err.message}`);
      error.code = 'WORKTREE_FAILED';
      throw error;
    }
  } finally {
    release();
  }
}

/**
 * Remove worktree, optionally delete branch (with safety checks and mutex)
 * @param {string} projectDir - Project root directory
 * @param {string} branchName - Sanitized branch name (without claude/ prefix)
 * @param {string} projectId - Project ID for mutex
 * @param {Object} options
 * @param {boolean} options.deleteBranch - Whether to delete the branch too
 * @returns {Promise<void>}
 */
export async function removeWorktree(projectDir, branchName, projectId, { deleteBranch = false } = {}) {
  // Validate branch name
  const branchValidation = await validateBranchName(branchName);
  if (!branchValidation.valid) {
    const err = new Error(`Invalid branch name: ${branchName}`);
    err.code = branchValidation.code;
    throw err;
  }

  // Validate .worktrees directory (path safety - same as createWorktree)
  const dirValidation = await validateWorktreesDir(projectDir);
  if (!dirValidation.valid) {
    const err = new Error(dirValidation.message);
    err.code = 'PATH_SAFETY_VIOLATION';
    throw err;
  }

  // Acquire project lock
  const release = await acquireProjectLock(projectId);

  try {
    const worktreePath = path.join(projectDir, '.worktrees', branchName);
    const fullBranchName = `claude/${branchName}`;

    // Verify worktree path is inside .worktrees (path safety)
    const worktreesDir = path.join(projectDir, '.worktrees');
    try {
      const resolvedWorktree = await fs.promises.realpath(worktreePath);
      const resolvedWorktreesDir = await fs.promises.realpath(worktreesDir);
      // Use path.sep suffix to prevent prefix bypass
      if (!resolvedWorktree.startsWith(resolvedWorktreesDir + path.sep) && resolvedWorktree !== resolvedWorktreesDir) {
        throw new Error('Path safety violation: worktree path escapes .worktrees/');
      }
    } catch (err) {
      // If path doesn't exist, that's fine - we're trying to remove it anyway
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }

    // Remove worktree
    try {
      await execFileAsync(
        'git',
        ['worktree', 'remove', '--force', '--', worktreePath],
        { cwd: projectDir }
      );
    } catch (err) {
      // Worktree might already be removed manually
      if (!err.stderr?.includes('is not a working tree') && !err.stderr?.includes('is not a valid')) {
        throw new Error(`Failed to remove worktree: ${err.stderr || err.message}`);
      }
    }

    // Delete branch if requested
    if (deleteBranch) {
      try {
        await execFileAsync(
          'git',
          ['branch', '-D', '--', fullBranchName],
          { cwd: projectDir }
        );
      } catch (err) {
        // Branch might already be deleted
        if (!err.stderr?.includes('not found')) {
          throw new Error(`Failed to delete branch: ${err.stderr || err.message}`);
        }
      }
    }
  } finally {
    release();
  }
}

/**
 * Check if worktree is registered with git (not just filesystem check)
 * @param {string} projectDir - Project root directory
 * @param {string} branchName - Sanitized branch name
 * @returns {Promise<boolean>}
 */
export async function worktreeExists(projectDir, branchName) {
  const worktreePath = path.join(projectDir, '.worktrees', branchName);

  try {
    // Use git worktree list to verify it's a real registered worktree
    const { stdout } = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: projectDir }
    );

    // Parse output to find our worktree - compare exact paths to avoid prefix false positives
    const target = await fs.promises.realpath(worktreePath).catch(() => path.resolve(worktreePath));
    const worktrees = stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
    const resolved = await Promise.all(
      worktrees.map((p) => fs.promises.realpath(p).catch(() => path.resolve(p)))
    );
    return resolved.includes(target);
  } catch {
    return false;
  }
}

/**
 * Error thrown when dirty check cannot be performed
 */
export class WorktreeDirtyCheckError extends Error {
  constructor(message, code = 'DIRTY_CHECK_FAILED') {
    super(message);
    this.name = 'WorktreeDirtyCheckError';
    this.code = code;
  }
}

/**
 * Check if worktree has uncommitted changes
 * @param {string} projectDir - Project root directory
 * @param {string} branchName - Sanitized branch name
 * @returns {Promise<boolean>}
 * @throws {WorktreeDirtyCheckError} when check cannot be performed
 */
export async function isWorktreeDirty(projectDir, branchName) {
  const worktreePath = path.join(projectDir, '.worktrees', branchName);

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain'],
      { cwd: worktreePath }
    );
    return stdout.trim().length > 0;
  } catch (err) {
    // Don't silently return false - throw so caller knows check failed
    // Determine if this is a missing worktree or other failure
    const stderr = `${err.stderr || ''}`.toLowerCase();
    const msg = `${err.message || ''}`.toLowerCase();
    let code = 'DIRTY_CHECK_FAILED';
    if (
      err.code === 'ENOENT' ||
      stderr.includes('no such file or directory') ||
      msg.includes('no such file or directory') ||
      stderr.includes('cannot change to')
    ) {
      code = 'WORKTREE_MISSING';
    }
    throw new WorktreeDirtyCheckError(
      `Cannot check dirty status: ${err.stderr || err.message}`,
      code
    );
  }
}

/**
 * Check if .worktrees/ is in .gitignore
 * @param {string} projectDir - Project root directory
 * @returns {Promise<boolean>}
 */
export async function isWorktreesIgnored(projectDir) {
  // Check both .worktrees and .worktrees/ patterns
  for (const pattern of ['.worktrees', '.worktrees/']) {
    try {
      await execFileAsync(
        'git',
        ['check-ignore', '-q', '--', pattern],
        { cwd: projectDir }
      );
      return true;
    } catch {
      // Not ignored by this pattern, try next
    }
  }
  return false;
}

/**
 * List all registered git worktrees under .worktrees/ for a project
 * @param {string} projectDir - Project root directory
 * @returns {Promise<Array<{absolutePath: string, relativePath: string}>>}
 */
export async function listProjectWorktrees(projectDir) {
  // Validate .worktrees directory safety
  const dirValidation = await validateWorktreesDir(projectDir);
  if (!dirValidation.valid) {
    return [];
  }

  let stdout;
  try {
    const result = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: projectDir }
    );
    stdout = result.stdout;
  } catch {
    return [];
  }

  const resolvedProject = await fs.promises.realpath(projectDir).catch(() => path.resolve(projectDir));
  const worktreesDir = path.join(resolvedProject, '.worktrees');

  const worktrees = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (!line.startsWith('worktree ')) continue;
    const absPath = line.slice('worktree '.length);
    const resolved = await fs.promises.realpath(absPath).catch(() => path.resolve(absPath));

    // Only include worktrees under .worktrees/
    if (!resolved.startsWith(worktreesDir + path.sep)) continue;

    const relativePath = path.relative(resolvedProject, resolved);
    worktrees.push({ absolutePath: resolved, relativePath });
  }

  return worktrees;
}

const GRACE_PERIOD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Remove orphaned worktrees across all projects.
 * An orphan is a git-registered worktree under .worktrees/ with no matching session.
 *
 * @param {object} store - Store instance with getProjects() and getSessionWorktreePaths()
 * @param {object} [options]
 * @param {number} [options.gracePeriodMs=600000] - Skip worktrees younger than this (ms)
 * @returns {Promise<{removed: number, skippedDirty: number, skippedGrace: number, errors: number}>}
 */
export async function cleanupOrphanedWorktrees(store, { gracePeriodMs = GRACE_PERIOD_MS } = {}) {
  const result = { removed: 0, skippedDirty: 0, skippedGrace: 0, errors: 0 };

  const projects = store.getProjects();

  for (const project of projects) {
    // Verify project directory still exists
    try {
      const stat = await fs.promises.stat(project.cwd);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    // Get all registered worktrees under .worktrees/
    const worktrees = await listProjectWorktrees(project.cwd);
    if (worktrees.length === 0) continue;

    // Get all session worktree paths for this project
    const sessionPaths = new Set(store.getSessionWorktreePaths(project.id));

    for (const worktree of worktrees) {
      // Check if this worktree has a matching session
      if (sessionPaths.has(worktree.relativePath)) continue;

      // Grace period: skip if worktree directory is too new
      if (gracePeriodMs > 0) {
        try {
          const stat = await fs.promises.stat(worktree.absolutePath);
          // birthtimeMs is unreliable on some Linux filesystems (returns 0);
          // fall back to mtimeMs which is close to creation time for new dirs
          const createdMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
          const ageMs = Date.now() - createdMs;
          if (ageMs < gracePeriodMs) {
            result.skippedGrace++;
            console.log(`[cleanup] Skipping young orphan (${Math.round(ageMs / 1000)}s old): ${worktree.relativePath}`);
            continue;
          }
        } catch {
          // If we can't stat it, proceed with removal attempt
        }
      }

      // Check if dirty
      const branchName = path.basename(worktree.relativePath);
      try {
        const dirty = await isWorktreeDirty(project.cwd, branchName);
        if (dirty) {
          result.skippedDirty++;
          console.log(`[cleanup] Skipping dirty orphan: ${worktree.relativePath}`);
          continue;
        }
      } catch (e) {
        if (e instanceof WorktreeDirtyCheckError && e.code === 'WORKTREE_MISSING') {
          // Worktree directory gone but still registered — proceed to prune
        } else {
          result.errors++;
          console.error(`[cleanup] Error checking dirty status for ${worktree.relativePath}: ${e.message}`);
          continue;
        }
      }

      // Remove the orphan worktree (never delete branch)
      try {
        await removeWorktree(project.cwd, branchName, project.id, { deleteBranch: false });
        result.removed++;
        console.log(`[cleanup] Removed orphan worktree: ${worktree.relativePath}`);
      } catch (e) {
        result.errors++;
        console.error(`[cleanup] Failed to remove ${worktree.relativePath}: ${e.message}`);
      }
    }

    // Prune stale git worktree refs
    try {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: project.cwd });
    } catch {
      // Best-effort
    }
  }

  console.log(`[cleanup] Complete: removed=${result.removed}, skippedDirty=${result.skippedDirty}, skippedGrace=${result.skippedGrace}, errors=${result.errors}`);
  return result;
}
