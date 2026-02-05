# Git Worktree Integration Design

**Date:** 2026-02-04
**Status:** Approved (v2 - incorporates review feedback)

## Overview

Add git worktree support to Claude Console so each session runs in an isolated worktree. This enables parallel experimentation — multiple Claude sessions can work on different approaches without affecting each other.

## Goals

- **Parallel experimentation:** Run multiple Claude sessions trying different approaches
- **Safe isolation:** Prevent one session's changes from breaking another session mid-work

## Non-Goals

- Merge workflow / PR creation from UI
- Branch comparison or diff viewing in UI
- Bare repository support
- Submodule support
- Reversible archive (archive is a terminal action)

## Design Decisions

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Worktree location | `.worktrees/<session-name>-<short-id>` inside project | Discoverable, collision-safe with ID suffix |
| Branch naming | `claude/<sanitized-name>-<short-id>` | Clear namespace, collision-safe |
| Branch source | Current HEAD at session creation | Lets Claude continue work on current branch |
| Non-git projects | Reject at project creation | Fail early, be explicit |
| Bare repos | Reject at project creation | No working tree to branch from |
| Empty repos | Reject at project creation | Unborn HEAD breaks `git worktree add -b` |
| Gitignore | Warn if `.worktrees/` not ignored | Don't auto-modify user files |
| Session name | Sanitized + short ID suffix | Deterministic, collision-safe |
| Failed worktree | Fail session creation | Be explicit about errors |
| Archive | Terminal action (no restore) | Removes session, keeps branch for manual recovery |
| Delete | Requires confirmation for dirty worktrees | Prevent accidental data loss |
| UI branch info | Show on hover/details | Keep sidebar clean |

## Session Lifecycle

### Create Session

1. Validate project is a git repo (enforced at project creation)
2. Sanitize session name → `baseName`
3. Generate `branchName` = `<baseName>-<short-session-id>` (first 7 chars of UUID)
4. Validate with `git check-ref-format --branch claude/<branchName>`
5. Run: `git worktree add -b claude/<branchName> .worktrees/<branchName>`
6. Warn (don't block) if `.worktrees/` not in `.gitignore`
7. Spawn Claude with `cwd = <project.cwd>/.worktrees/<branchName>`

### Claude Process Exits

- Session shows as "exited" in UI
- Worktree remains intact (uncommitted changes preserved)

### Restart Session

- Check if worktree exists
  - If missing: error with message "Worktree was removed. Delete this session and create a new one."
- Spawn Claude in the existing worktree
- Resume conversation with `--resume`

### Archive Session (Terminal)

- Kill Claude process
- Run: `git worktree remove --force .worktrees/<branchName>`
- Keep branch (`claude/<branchName>` remains in git for manual recovery)
- Remove session from data store
- **Not reversible** — session is gone, only branch remains

### Delete Session

- Kill Claude process
- Check for uncommitted changes in worktree
  - If dirty: require explicit confirmation (UI prompt or `?force=true` query param)
- Run: `git worktree remove --force .worktrees/<branchName>`
- Run: `git branch -D -- claude/<branchName>`
- Remove session from data store

## Security

### Path Safety

All path operations must validate:
- `worktreePath` resolves inside `.worktrees/` (use `realpath`)
- `.worktrees/` is not a symlink pointing outside the repo
- No path traversal (`..`) in branch names

### Ref Safety

All branch operations must validate:
- Branch ref is under `refs/heads/claude/`
- Use `--` separator in git commands to prevent option injection
- Validate branch names with `git check-ref-format`

### Command Safety

- Use `execFile` with argument arrays (no shell interpolation)
- Never concatenate user input into shell commands

## Data Model Changes

```javascript
// Session object - new fields
{
  id: "uuid",
  projectId: "uuid",
  name: "Fix Auth Bug!",           // Display name (unchanged)
  claudeSessionId: "uuid",
  status: "running",
  createdAt: "ISO-8601",
  branchName: "fix-auth-bug-a1b2c3d",  // NEW: Sanitized + short ID
  worktreePath: ".worktrees/fix-auth-bug-a1b2c3d"  // NEW: Relative to project.cwd
}
```

## API Changes

### `POST /api/projects` (modified)

**New validation:**
- Check directory is a git repository
- Check repository is not bare (`git rev-parse --is-bare-repository`)
- Check HEAD exists (`git rev-parse HEAD`)

**Error codes:**
| Code | Message |
|------|---------|
| `NOT_GIT_REPO` | "Directory is not a git repository" |
| `BARE_REPO` | "Bare repositories are not supported" |
| `EMPTY_REPO` | "Repository has no commits. Make an initial commit first." |

### `POST /api/projects/:id/sessions` (modified)

**New behavior:**
- Sanitize session name + append short ID → `branchName`
- Create worktree at `.worktrees/<branchName>`
- Create branch `claude/<branchName>` from HEAD
- Store `branchName` and `worktreePath` in session
- Spawn Claude in worktree directory
- Warn if `.worktrees/` not gitignored (non-blocking)

**Error codes:**
| Code | Message |
|------|---------|
| `INVALID_BRANCH_NAME` | "Session name produces invalid branch name" |
| `WORKTREE_FAILED` | "Failed to create worktree: <git stderr>" |

### `POST /api/sessions/:id/archive` (new)

**Behavior:**
- Kill Claude process
- Force-remove worktree directory
- Keep branch intact
- Remove session from data store

**Response:**
```json
{
  "ok": true,
  "branch": "claude/fix-auth-bug-a1b2c3d",
  "message": "Session archived. Branch preserved for manual recovery."
}
```

### `DELETE /api/sessions/:id` (modified)

**Query params:**
- `force=true` — skip dirty worktree confirmation

**Behavior:**
- Check for uncommitted changes
- If dirty and `force` not set: return `DIRTY_WORKTREE` error
- Kill Claude process
- Force-remove worktree
- Delete branch
- Remove session from data store

**Error codes:**
| Code | Message |
|------|---------|
| `DIRTY_WORKTREE` | "Worktree has uncommitted changes. Use force=true to delete anyway." |

## New Module: `git-worktree.js`

```javascript
// Check if directory is a valid git repository (not bare, has commits)
async function validateGitRepo(dir) → { valid: boolean, error?: string }

// Create worktree and branch (with path/ref safety checks)
async function createWorktree(projectDir, branchName) → void

// Remove worktree, optionally delete branch (with safety checks)
async function removeWorktree(projectDir, branchName, { deleteBranch, force }) → void

// Check if worktree has uncommitted changes
async function isWorktreeDirty(projectDir, branchName) → boolean

// Check if worktree directory exists
async function worktreeExists(projectDir, branchName) → boolean

// Convert session name to branch-safe format (deterministic)
function sanitizeBranchName(sessionName) → string

// Check if .worktrees/ is in .gitignore
async function isWorktreesIgnored(projectDir) → boolean
```

## Concurrency

**Per-project mutex:**
- Worktree operations (create, remove) acquire a lock keyed by project ID
- Prevents race conditions when creating sessions with similar names
- Lock timeout: 30 seconds
- Implementation: in-memory Map of promises (single-process server)

## UI Changes

### Sidebar
- No change — session names display as-is

### Session Hover/Tooltip
- Show branch: `claude/fix-auth-bug-a1b2c3d`
- Show path: `.worktrees/fix-auth-bug-a1b2c3d`

### Session Context Menu
- "Archive" — terminal action, keeps branch
- "Delete" — full cleanup, prompts if dirty

### Delete Confirmation (dirty worktree)
- Show: "This session has uncommitted changes that will be lost. Delete anyway?"
- Buttons: "Cancel" / "Delete"

### Project Creation Modal
- Show inline error for:
  - "Not a git repository. Run `git init` first."
  - "Bare repositories are not supported."
  - "Repository has no commits. Make an initial commit first."

### Gitignore Warning
- On session creation, if `.worktrees/` not ignored:
- Show non-blocking toast: "Consider adding `.worktrees/` to your .gitignore"

## Name Sanitization Rules

Deterministic transformation:

```
Input               → Output (before ID suffix)
"Fix Auth Bug!"     → "fix-auth-bug"
"Add   spaces"      → "add-spaces"
"UPPERCASE"         → "uppercase"
"foo/bar"           → "foo-bar"
"hello_world"       → "hello-world"
"  trimmed  "       → "trimmed"
"émojis 🚀"         → "emojis"
""                  → "session"  (fallback)
```

Rules:
1. Convert to lowercase
2. Replace non-alphanumeric chars with hyphens
3. Collapse multiple hyphens
4. Trim leading/trailing hyphens
5. Truncate to 50 chars (to avoid path length issues)
6. Fallback to "session" if empty
7. Append `-<short-id>` (7 chars from session UUID)

## Error Handling

| Code | User Message |
|------|--------------|
| `NOT_GIT_REPO` | "Directory is not a git repository" |
| `BARE_REPO` | "Bare repositories are not supported" |
| `EMPTY_REPO` | "Repository has no commits. Make an initial commit first." |
| `INVALID_BRANCH_NAME` | "Session name produces invalid branch name" |
| `WORKTREE_FAILED` | "Failed to create worktree: <details>" |
| `WORKTREE_MISSING` | "Worktree was removed. Delete this session and create a new one." |
| `DIRTY_WORKTREE` | "Worktree has uncommitted changes. Use force to delete anyway." |

## Implementation Tasks

1. **Task #1:** Create `git-worktree.js` helper module
2. **Task #2:** Update `server.js` for worktree integration (blocked by #1)
3. **Task #3:** Update frontend for worktree UI (blocked by #2)
4. **Task #4:** Add tests for worktree functionality (blocked by #1, #2)
5. **Task #5:** Create worktree documentation (blocked by #2)

## Testing Strategy

**Unit tests:**
- `sanitizeBranchName()` with various inputs including edge cases
- `validateGitRepo()` for git repos, non-git dirs, bare repos, empty repos
- `isWorktreesIgnored()` for various .gitignore states
- Path/ref safety validation

**Integration tests:**
- Full session lifecycle with temp git repos
- Worktree creation and cleanup
- Restart with existing worktree
- Restart with missing worktree (error case)
- Archive preserves branch
- Delete removes branch
- Delete with dirty worktree (force and non-force)
- Concurrent session creation (race condition)
- Path traversal attempts (security)

## Future Considerations

- Merge workflow from UI
- Branch comparison / diff viewing
- Bulk cleanup of archived branches
- Submodule support (auto-init on worktree creation)
- Bare repo support (clone to temp location)
