# Git Worktree Integration Design

**Date:** 2026-02-04
**Status:** Approved

## Overview

Add git worktree support to Claude Console so each session runs in an isolated worktree. This enables parallel experimentation — multiple Claude sessions can work on different approaches without affecting each other.

## Goals

- **Parallel experimentation:** Run multiple Claude sessions trying different approaches
- **Safe isolation:** Prevent one session's changes from breaking another session mid-work

## Non-Goals (for now)

- Merge workflow / PR creation from UI
- Branch comparison or diff viewing in UI

## Design Decisions

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Worktree location | `.worktrees/<session-name>` inside project | Keeps everything discoverable, easy cleanup |
| Branch naming | `claude/<sanitized-session-name>` | Clear namespace, identifies Claude's work |
| Branch source | Current HEAD at session creation | Lets Claude continue work on current branch |
| Non-git projects | Reject at project creation | Fail early, be explicit |
| Gitignore | Auto-add `.worktrees/` | Prevent accidental commits |
| Session name | Sanitized for branches | "Fix Auth Bug!" → `fix-auth-bug` |
| Failed worktree | Fail session creation | Be explicit about errors |
| UI branch info | Show on hover/details | Keep sidebar clean |

## Session Lifecycle

### Create Session

1. Validate project is a git repo (enforced at project creation)
2. Sanitize session name → `branchName`
3. Check if branch `claude/<branchName>` exists → error if yes
4. Run: `git worktree add -b claude/<branchName> .worktrees/<branchName>`
5. If first worktree, append `.worktrees/` to `.gitignore`
6. Spawn Claude with `cwd = <project.cwd>/.worktrees/<branchName>`

### Claude Process Exits

- Session shows as "exited" in UI
- Worktree remains intact (uncommitted changes preserved)

### Restart Session

- Spawn Claude in the existing worktree
- Resume conversation with `--resume`
- No worktree recreation

### Archive Session

- Kill Claude process
- Run: `git worktree remove .worktrees/<branchName>`
- Keep branch (`claude/<branchName>` remains in git)
- Remove session from data store

### Delete Session

- Kill Claude process
- Run: `git worktree remove .worktrees/<branchName>`
- Run: `git branch -D claude/<branchName>`
- Remove session from data store

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
  branchName: "fix-auth-bug",      // NEW: Sanitized branch suffix
  worktreePath: ".worktrees/fix-auth-bug"  // NEW: Relative to project.cwd
}
```

## API Changes

### `POST /api/projects` (modified)

**New validation:**
- Check directory is a git repository
- Error: `"Directory is not a git repository"`

### `POST /api/projects/:id/sessions` (modified)

**New behavior:**
- Sanitize session name to `branchName`
- Create worktree at `.worktrees/<branchName>`
- Create branch `claude/<branchName>` from HEAD
- Store `branchName` and `worktreePath` in session
- Spawn Claude in worktree directory

**New errors:**
- `"Branch 'claude/fix-auth' already exists. Choose a different session name."`
- `"Failed to create worktree: <git error>"`

### `POST /api/sessions/:id/archive` (new)

**Behavior:**
- Kill Claude process
- Remove worktree directory
- Keep branch intact
- Remove session from data store

### `DELETE /api/sessions/:id` (modified)

**New behavior:**
- Also delete the branch after removing worktree

## New Module: `git-worktree.js`

```javascript
// Check if directory is a git repository
async function isGitRepo(dir) → boolean

// Create worktree and branch
async function createWorktree(projectDir, branchName) → void
// Runs: git worktree add -b claude/<branchName> .worktrees/<branchName>

// Remove worktree, optionally delete branch
async function removeWorktree(projectDir, branchName, deleteBranch) → void
// Runs: git worktree remove .worktrees/<branchName>
// If deleteBranch: git branch -D claude/<branchName>

// Convert session name to branch-safe format
function sanitizeBranchName(sessionName) → string
// "Fix Auth Bug!" → "fix-auth-bug"

// Add .worktrees/ to .gitignore if not present
async function ensureGitignore(projectDir) → void
```

## UI Changes

### Sidebar
- No change — session names display as-is

### Session Hover/Tooltip
- Show branch: `claude/fix-auth-bug`
- Show path: `.worktrees/fix-auth-bug`

### Session Context Menu
- Add "Archive" option
- Keep "Delete" for full cleanup

### Project Creation Modal
- Show inline error if directory is not a git repo
- Message: "Not a git repository. Run `git init` first."

## Name Sanitization Rules

```
Input               → Output
"Fix Auth Bug!"     → "fix-auth-bug"
"Add   spaces"      → "add-spaces"
"UPPERCASE"         → "uppercase"
"foo/bar"           → "foo-bar"
"hello_world"       → "hello-world" (optional: keep underscores?)
"  trimmed  "       → "trimmed"
```

## Error Handling

| Error | User Message |
|-------|--------------|
| Not a git repo | "Directory is not a git repository" |
| Branch exists | "Branch 'claude/fix-auth' already exists. Choose a different session name." |
| Worktree creation fails | "Failed to create worktree: <git stderr>" |
| Dirty worktree on remove | Force remove or warn user |

## Implementation Tasks

1. **Task #1:** Create `git-worktree.js` helper module
2. **Task #2:** Update `server.js` for worktree integration (blocked by #1)
3. **Task #3:** Update frontend for worktree UI (blocked by #2)
4. **Task #4:** Add tests for worktree functionality (blocked by #1, #2)
5. **Task #5:** Create worktree documentation (blocked by #2)

## Testing Strategy

**Unit tests:**
- `sanitizeBranchName()` with various inputs
- `isGitRepo()` for git and non-git directories
- `ensureGitignore()` idempotency

**Integration tests:**
- Full session lifecycle with temp git repos
- Worktree creation and cleanup
- Error cases (branch collision, non-git directory)

## Future Considerations

- Merge workflow from UI (not in scope)
- Branch comparison / diff viewing
- Bulk cleanup of archived branches
- "Keep branch" option on delete
