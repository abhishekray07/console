# Git Worktree Integration Guide

## Overview

Each Claude session in Claude Console runs in an isolated git worktree. This enables parallel experimentation — multiple sessions can work on different approaches simultaneously without conflicts.

### What is a Worktree?

A git worktree is a linked working copy of your repository. Each worktree:
- Has its own working directory and index
- Can have different files checked out
- Shares the same `.git` history with the main repo

### How It Works

When you create a session:
1. Claude Console creates a new branch from your current HEAD
2. A worktree is created in `.worktrees/` pointing to that branch
3. Claude runs inside the worktree directory
4. Changes stay isolated until you merge them

## Branch Naming

### Pattern

```
claude/{sanitized-session-name}-{7-char-uuid}
```

### Examples

| Session Name | Branch Name |
|--------------|-------------|
| Fix Auth Bug! | `claude/fix-auth-bug-a1b2c3d` |
| Add New Feature | `claude/add-new-feature-b2c3d4e` |
| UPPERCASE | `claude/uppercase-c3d4e5f` |

### Sanitization Rules

Session names are converted to branch-safe format:
- Lowercase
- Special characters replaced with hyphens
- Multiple hyphens collapsed
- Truncated to 50 characters
- 7-character UUID suffix ensures uniqueness

## Worktree Location

Worktrees are stored inside your project:

```
your-project/
├── .worktrees/
│   ├── fix-auth-bug-a1b2c3d/    # Session 1's worktree
│   └── add-feature-b2c3d4e/     # Session 2's worktree
├── src/
└── ...
```

## Archive vs Delete

### Archive

Removes the worktree directory but **preserves the branch**.

**Use when:**
- Session is complete but you want to keep the work
- You plan to merge the branch later
- You want to review the changes before deciding

**What happens:**
- Worktree directory removed
- Branch remains in git (`claude/...`)
- Session removed from UI
- **Not reversible** — session is gone, only branch remains

**Recovery:** Check out or merge the branch manually:
```bash
git checkout claude/fix-auth-bug-a1b2c3d
# or
git merge claude/fix-auth-bug-a1b2c3d
```

### Delete

Removes **both** the worktree and the branch.

**Use when:**
- Work is abandoned or merged
- You want full cleanup

**What happens:**
- Worktree directory removed
- Branch deleted
- Session removed from UI
- **Permanent** — work is lost if not merged

**Force required:** If the worktree has uncommitted changes, you must confirm deletion to prevent accidental data loss.

## Troubleshooting

### WORKTREE_MISSING

**Message:** "Worktree was removed. Delete this session and create a new one."

**Cause:** The worktree directory was removed externally (manual deletion, `git worktree prune`, etc.)

**Solution:** Delete the session from Claude Console and create a new one.

### DIRTY_WORKTREE

**Message:** "Worktree has uncommitted changes. Use force to delete anyway."

**Cause:** Attempting to delete a session with uncommitted changes.

**Solutions:**
1. Commit or stash changes in the worktree first
2. Use force delete (acknowledges data loss)
3. Archive instead (preserves branch)

### NOT_GIT_REPO

**Message:** "Directory is not a git repository"

**Cause:** Trying to add a project that isn't a git repository.

**Solution:** Initialize git in the directory:
```bash
cd /path/to/project
git init
```

### EMPTY_REPO

**Message:** "Repository has no commits. Make an initial commit first."

**Cause:** Repository exists but has no commits (unborn HEAD).

**Solution:** Make an initial commit:
```bash
git add .
git commit -m "Initial commit"
```

### BARE_REPO

**Message:** "Bare repositories are not supported"

**Cause:** The repository is a bare repo (no working directory).

**Solution:** Use a non-bare clone of the repository.

### INVALID_BRANCH_NAME

**Message:** "Session name produces invalid branch name"

**Cause:** Session name, after sanitization, produces an invalid git ref.

**Solution:** Use a different session name with alphanumeric characters.

## Best Practices

### 1. Add `.worktrees/` to `.gitignore`

Prevent accidentally committing worktree directories:

```bash
echo ".worktrees/" >> .gitignore
git add .gitignore
git commit -m "Ignore worktree directories"
```

Claude Console warns (non-blocking) if this isn't configured.

### 2. Prefer Archive Over Delete

Archive preserves branches for later review or recovery. Only delete when you're certain the work should be discarded.

### 3. Commit Before Closing

Have Claude commit meaningful changes before ending a session. This makes recovery and merging easier.

### 4. Clean Up Old Branches

After merging or discarding archived session branches:

```bash
# List claude branches
git branch --list 'claude/*'

# Delete a specific branch
git branch -d claude/fix-auth-bug-a1b2c3d

# Delete all claude branches (careful!)
git branch --list 'claude/*' | xargs git branch -D
```

### 5. One Experiment Per Session

Create separate sessions for different approaches. This keeps changes isolated and makes comparison easier.

## Branch Recovery After Archive

Archived sessions leave their branches intact. To recover work:

```bash
# List available branches
git branch --list 'claude/*'

# View branch history
git log claude/fix-auth-bug-a1b2c3d --oneline

# Create a new worktree to continue work
git worktree add .worktrees/recovered claude/fix-auth-bug-a1b2c3d

# Or merge into current branch
git merge claude/fix-auth-bug-a1b2c3d

# Or cherry-pick specific commits
git cherry-pick <commit-hash>
```
