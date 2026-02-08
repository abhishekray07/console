// app.js
(function () {
  'use strict';

  // --- State ---
  let ws = null;
  let term = null;
  let fitAddon = null;
  let activeSessionId = null;
  let projects = [];
  let sessions = [];
  let expandedProjects = new Set();
  let reconnectDelay = 1000;
  let toastTimeout = null;
  let shellTerm = null;
  let shellFitAddon = null;
  let expandedDirs = new Set(); // tracks expanded directory paths in file tree
  let openTabs = []; // { id, filename, fullPath, content, type }
  let activeTabId = 'claude';

  // --- Sticky scroll state ---
  const NEAR_BOTTOM_LINES = 2;
  let claudeSticky = true;
  let claudePendingScroll = false;
  let shellSticky = true;
  let shellPendingScroll = false;

  function isNearBottom(t) {
    const buf = t.buffer.active;
    // Alternate screen (e.g. vim, less) has no scrollback; always "at bottom"
    if (buf.type === 'alternate') return true;
    return (buf.baseY - buf.viewportY) <= NEAR_BOTTOM_LINES;
  }

  // --- DOM refs ---
  const projectListEl = document.getElementById('project-list');
  const terminalEl = document.getElementById('terminal');
  const noSession = document.getElementById('no-session');
  const btnAddProject = document.getElementById('btn-add-project');
  const btnHomeAddProject = document.getElementById('btn-home-add-project');
  const modalOverlay = document.getElementById('modal-overlay');
  const modalProjectName = document.getElementById('modal-project-name');
  const modalProjectPath = document.getElementById('modal-project-path');
  const btnBrowse = document.getElementById('btn-browse');
  const dirBrowser = document.getElementById('dir-browser');
  const dirBreadcrumbs = document.getElementById('dir-breadcrumbs');
  const dirList = document.getElementById('dir-list');
  const btnSelectDir = document.getElementById('btn-select-dir');
  const btnModalCancel = document.getElementById('btn-modal-cancel');
  const btnModalCreate = document.getElementById('btn-modal-create');
  const rightPanel = document.getElementById('right-panel');
  const shellTerminalEl = document.getElementById('shell-terminal');
  const rightPanelPath = document.getElementById('right-panel-path');
  const fileTreeEl = document.getElementById('file-tree');
  const tabBar = document.getElementById('tab-bar');
  const tabList = document.getElementById('tab-list');
  const fileViewer = document.getElementById('file-viewer');
  const fileViewerPath = document.getElementById('file-viewer-path');
  const fileViewerRefresh = document.getElementById('file-viewer-refresh');
  const fileViewerContent = document.getElementById('file-viewer-content');
  const btnToggleFileTree = document.getElementById('btn-toggle-file-tree');
  const fileTreeSection = document.getElementById('file-tree-section');

  // --- Helpers ---
  function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }

  function debounce(fn, ms) {
    let timer;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  function relativeTime(isoString) {
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  // --- Toast notifications ---
  function showToast(message, type = 'info', duration = 4000) {
    // Remove existing toast if any
    const existing = document.getElementById('toast');
    if (existing) {
      existing.remove();
      clearTimeout(toastTimeout);
    }

    const toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // --- Confirmation dialog ---
  function showConfirmDialog(title, message, onConfirm, onCancel) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const titleEl = document.createElement('h3');
    titleEl.textContent = title;

    const messageEl = document.createElement('p');
    messageEl.textContent = message;

    const buttons = document.createElement('div');
    buttons.className = 'confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirm-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => {
      overlay.remove();
      if (onCancel) onCancel();
    };

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'confirm-ok';
    confirmBtn.textContent = 'Delete Anyway';
    confirmBtn.onclick = () => {
      overlay.remove();
      if (onConfirm) onConfirm();
    };

    buttons.appendChild(cancelBtn);
    buttons.appendChild(confirmBtn);
    dialog.appendChild(titleEl);
    dialog.appendChild(messageEl);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Close on overlay click
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        overlay.remove();
        if (onCancel) onCancel();
      }
    };

    // Close on Escape
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', handleEscape);
        if (onCancel) onCancel();
      }
    };
    document.addEventListener('keydown', handleEscape);
  }

  // --- Terminal setup ---
  function initTerminal() {
    term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontWeight: '400',
      fontWeightBold: '600',
      lineHeight: 1.2,
      letterSpacing: 0,
      allowTransparency: false,
      theme: {
        background: '#1a1a2e',
        foreground: '#d4d4d4',
        cursor: '#e94560',
        cursorAccent: '#1a1a2e',
        selectionBackground: '#3a3a5e',
        black: '#1a1a2e',
        red: '#f44747',
        green: '#4ec9b0',
        yellow: '#dcdcaa',
        blue: '#569cd6',
        magenta: '#c586c0',
        cyan: '#9cdcfe',
        white: '#d4d4d4',
        brightBlack: '#6b7280',
        brightRed: '#f44747',
        brightGreen: '#4ec9b0',
        brightYellow: '#dcdcaa',
        brightBlue: '#569cd6',
        brightMagenta: '#c586c0',
        brightCyan: '#9cdcfe',
        brightWhite: '#ffffff',
      },
    });

    fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    const webglAddon = new WebglAddon.WebglAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalEl);

    // WebGL addon for sharper rendering on high-DPI displays
    try {
      term.loadAddon(webglAddon);
    } catch (e) {
      console.warn('WebGL addon failed, using canvas renderer');
    }

    fitAddon.fit();

    term.attachCustomKeyEventHandler((event) => {
      if (event.key === 'Enter' && event.shiftKey) {
        if (event.type === 'keydown' && activeSessionId) {
          wsSend(JSON.stringify({ type: 'input', data: '\x1b[13;2u' }));
        }
        return false;
      }
      return true;
    });

    term.onData((data) => {
      if (activeSessionId) {
        wsSend(JSON.stringify({ type: 'input', data }));
      }
    });

    const handleResize = debounce(() => {
      if (fitAddon) {
        fitAddon.fit();
        if (activeSessionId) {
          wsSend(JSON.stringify({
            type: 'resize',
            cols: term.cols,
            rows: term.rows,
          }));
        }
      }
    }, 100);

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(terminalEl);

    // Sticky scroll: track user scroll position.
    // Skip when a write-triggered scroll is pending — onScroll fires mid-write
    // when baseY increases before viewport catches up, which would incorrectly
    // set sticky=false and cancel the pending scroll.
    term.onScroll(() => {
      if (claudePendingScroll) return;
      const was = claudeSticky;
      claudeSticky = isNearBottom(term);
      if (was && !claudeSticky) {
        console.debug('[scroll] claude: user scrolled away from bottom');
      }
    });

    // Sticky scroll: scroll after writes are parsed (frame-limited)
    term.onWriteParsed(() => {
      if (!claudePendingScroll) return;
      claudePendingScroll = false;
      term.scrollToBottom();
      claudeSticky = true;
    });
  }

  function initShellTerminal() {
    shellTerm = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontWeight: '400',
      fontWeightBold: '600',
      lineHeight: 1.2,
      letterSpacing: 0,
      allowTransparency: false,
      theme: {
        background: '#1a1a2e',
        foreground: '#d4d4d4',
        cursor: '#e94560',
        cursorAccent: '#1a1a2e',
        selectionBackground: '#3a3a5e',
        black: '#1a1a2e',
        red: '#f44747',
        green: '#4ec9b0',
        yellow: '#dcdcaa',
        blue: '#569cd6',
        magenta: '#c586c0',
        cyan: '#9cdcfe',
        white: '#d4d4d4',
        brightBlack: '#6b7280',
        brightRed: '#f44747',
        brightGreen: '#4ec9b0',
        brightYellow: '#dcdcaa',
        brightBlue: '#569cd6',
        brightMagenta: '#c586c0',
        brightCyan: '#9cdcfe',
        brightWhite: '#ffffff',
      },
    });

    shellFitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();

    shellTerm.loadAddon(shellFitAddon);
    shellTerm.loadAddon(webLinksAddon);
    shellTerm.open(shellTerminalEl);

    try {
      const webglAddon = new WebglAddon.WebglAddon();
      shellTerm.loadAddon(webglAddon);
    } catch (e) {
      console.warn('Shell WebGL addon failed, using canvas renderer');
    }

    shellFitAddon.fit();

    shellTerm.attachCustomKeyEventHandler((event) => {
      if (event.key === 'Enter' && event.shiftKey) {
        if (event.type === 'keydown' && activeSessionId) {
          wsSend(JSON.stringify({ type: 'shell-input', sessionId: activeSessionId, data: '\x1b[13;2u' }));
        }
        return false;
      }
      return true;
    });

    shellTerm.onData((data) => {
      if (activeSessionId) {
        wsSend(JSON.stringify({ type: 'shell-input', sessionId: activeSessionId, data }));
      }
    });

    const handleShellResize = debounce(() => {
      if (shellFitAddon) {
        shellFitAddon.fit();
        if (activeSessionId) {
          wsSend(JSON.stringify({
            type: 'shell-resize',
            sessionId: activeSessionId,
            cols: shellTerm.cols,
            rows: shellTerm.rows,
          }));
        }
      }
    }, 100);

    const shellResizeObserver = new ResizeObserver(handleShellResize);
    shellResizeObserver.observe(shellTerminalEl);

    // Sticky scroll: skip when write-triggered scroll is pending (same race fix)
    shellTerm.onScroll(() => {
      if (shellPendingScroll) return;
      const was = shellSticky;
      shellSticky = isNearBottom(shellTerm);
      if (was && !shellSticky) {
        console.debug('[scroll] shell: user scrolled away from bottom');
      }
    });

    // Sticky scroll: scroll after writes are parsed (frame-limited)
    shellTerm.onWriteParsed(() => {
      if (!shellPendingScroll) return;
      shellPendingScroll = false;
      shellTerm.scrollToBottom();
      shellSticky = true;
    });
  }

  // --- WebSocket ---
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
      reconnectDelay = 1000;
      if (activeSessionId) {
        attachSession(activeSessionId);
      }
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'output':
          if (msg.sessionId === activeSessionId && msg.data) {
            if (claudeSticky) claudePendingScroll = true;
            term.write(msg.data);
          }
          break;

        case 'replay-done':
          if (msg.sessionId === activeSessionId) {
            // Wait for write pipeline to drain, then wait for render before scrolling
            term.write('', () => {
              requestAnimationFrame(() => {
                term.scrollToBottom();
                claudeSticky = true;
              });
            });
          }
          break;

        case 'state':
          projects = msg.projects;
          sessions = msg.sessions;
          // Reconcile: if active session no longer exists, return to home
          if (activeSessionId && !sessions.find((s) => s.id === activeSessionId)) {
            activeSessionId = null;
            term.reset();
            noSession.classList.remove('hidden');
            rightPanel.classList.add('hidden');
            tabBar.classList.remove('visible');
            fileViewer.classList.add('hidden');
            document.getElementById('terminal-wrapper').style.display = '';
            document.getElementById('terminal-wrapper').style.inset = '0';
          }
          renderSidebar();
          break;

        case 'session-deleted':
          if (msg.sessionId === activeSessionId) {
            activeSessionId = null;
            term.reset();
            noSession.classList.remove('hidden');
            rightPanel.classList.add('hidden');
            tabBar.classList.remove('visible');
            fileViewer.classList.add('hidden');
            document.getElementById('terminal-wrapper').style.display = '';
            document.getElementById('terminal-wrapper').style.inset = '0';
          }
          break;

        case 'exited':
          // Session still exists, just re-render sidebar to update status dot
          renderSidebar();
          break;

        case 'shell-output':
          if (msg.sessionId === activeSessionId && msg.data) {
            if (shellSticky) shellPendingScroll = true;
            shellTerm.write(msg.data);
          }
          break;

        case 'shell-replay-done':
          if (msg.sessionId === activeSessionId) {
            shellTerm.write('', () => {
              requestAnimationFrame(() => {
                shellTerm.scrollToBottom();
                shellSticky = true;
              });
            });
          }
          break;
      }
    };

    ws.onclose = () => {
      const jitter = reconnectDelay * (0.5 + Math.random());
      setTimeout(connect, jitter);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };

    ws.onerror = () => { ws.close(); };
  }

  function attachSession(sessionId) {
    activeSessionId = sessionId;
    term.reset();
    shellTerm.reset();
    claudeSticky = true;
    claudePendingScroll = false;
    shellSticky = true;
    shellPendingScroll = false;
    noSession.classList.add('hidden');

    // Show right panel and update path display
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      rightPanel.classList.remove('hidden');
      rightPanelPath.textContent = session.worktreePath || '';
      rightPanelPath.title = session.worktreePath || '';

      // Reset tabs and file tree for new session
      openTabs = [];
      activeTabId = 'claude';
      switchTab('claude');
      renderTabs();
      initFileTree();
    } else {
      rightPanel.classList.add('hidden');
    }

    wsSend(JSON.stringify({
      type: 'attach',
      sessionId,
      cols: term.cols,
      rows: term.rows,
    }));

    // Attach shell terminal
    wsSend(JSON.stringify({
      type: 'shell-attach',
      sessionId,
      cols: shellTerm.cols,
      rows: shellTerm.rows,
    }));

    term.focus();
    renderSidebar();
  }

  // --- Sidebar ---
  function renderSidebar() {
    projectListEl.innerHTML = '';

    // Sort projects by createdAt ascending (design spec)
    const sortedProjects = [...projects].sort((a, b) =>
      new Date(a.createdAt) - new Date(b.createdAt));

    for (const proj of sortedProjects) {
      const group = document.createElement('div');
      group.className = 'project-group';
      group.dataset.projectId = proj.id;

      // Project header
      const header = document.createElement('div');
      header.className = 'project-header';

      const arrow = document.createElement('span');
      arrow.className = 'project-arrow';
      if (expandedProjects.has(proj.id)) arrow.classList.add('expanded');
      arrow.textContent = '\u25B6';

      const name = document.createElement('span');
      name.className = 'project-name';
      name.textContent = proj.name;

      const del = document.createElement('button');
      del.className = 'project-delete';
      del.textContent = '\u00D7';
      del.title = 'Delete project';
      del.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Delete project "${proj.name}" and all its sessions?`)) {
          deleteProject(proj.id);
        }
      };

      header.appendChild(arrow);
      header.appendChild(name);
      header.appendChild(del);

      header.onclick = () => {
        if (expandedProjects.has(proj.id)) {
          expandedProjects.delete(proj.id);
        } else {
          expandedProjects.add(proj.id);
        }
        renderSidebar();
      };

      group.appendChild(header);

      // Sessions list
      const projSessions = sessions
        .filter((s) => s.projectId === proj.id)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      const ul = document.createElement('ul');
      ul.className = 'project-sessions';
      if (expandedProjects.has(proj.id)) ul.classList.add('expanded');

      for (const s of projSessions) {
        const li = document.createElement('li');
        if (s.id === activeSessionId) li.classList.add('active');

        const dot = document.createElement('span');
        dot.className = 'status-dot';
        dot.classList.add(s.alive ? 'alive' : 'exited');

        // Session info container (name + optional branch badge)
        const infoContainer = document.createElement('div');
        infoContainer.className = 'session-info';

        const sName = document.createElement('span');
        sName.className = 'session-name';
        sName.textContent = s.name;
        infoContainer.appendChild(sName);

        // Branch badge (if session has worktree)
        if (s.branchName) {
          const branchBadge = document.createElement('span');
          branchBadge.className = 'branch-badge';
          branchBadge.textContent = s.branchName;
          branchBadge.title = s.worktreePath || s.branchName;
          infoContainer.appendChild(branchBadge);
        }

        const time = document.createElement('span');
        time.className = 'session-time';
        time.textContent = relativeTime(s.createdAt);

        // Session actions container
        const actions = document.createElement('div');
        actions.className = 'session-actions';

        // Archive button (only show if session has worktree)
        if (s.worktreePath) {
          const sArchive = document.createElement('button');
          sArchive.className = 'session-archive';
          sArchive.innerHTML = '&#128451;'; // Archive icon
          sArchive.title = 'Archive (keep branch, remove worktree)';
          sArchive.onclick = (e) => {
            e.stopPropagation();
            archiveSession(s.id, s.branchName);
          };
          actions.appendChild(sArchive);
        }

        const sDel = document.createElement('button');
        sDel.className = 'session-delete';
        sDel.textContent = '\u00D7';
        sDel.title = 'Delete session';
        sDel.onclick = (e) => {
          e.stopPropagation();
          deleteSession(s.id);
        };
        actions.appendChild(sDel);

        li.appendChild(dot);
        li.appendChild(infoContainer);
        li.appendChild(time);
        li.appendChild(actions);

        li.onclick = () => {
          if (!s.alive && s.claudeSessionId) {
            restartSession(s.id);
          }
          attachSession(s.id);
        };

        ul.appendChild(li);
      }

      // New session button
      const newBtn = document.createElement('button');
      newBtn.className = 'btn-new-session';
      newBtn.textContent = '+ New Session';
      newBtn.onclick = (e) => {
        e.stopPropagation();
        showInlineSessionInput(ul, proj.id);
      };

      if (expandedProjects.has(proj.id)) {
        ul.appendChild(document.createElement('li')).appendChild(newBtn);
      }

      group.appendChild(ul);
      projectListEl.appendChild(group);
    }
  }

  function showInlineSessionInput(ul, projectId) {
    // Remove any existing inline input
    const existing = ul.querySelector('.inline-session-input');
    if (existing) { existing.remove(); return; }

    const input = document.createElement('input');
    input.className = 'inline-session-input';
    input.type = 'text';
    input.placeholder = 'Session name...';
    ul.insertBefore(input, ul.lastElementChild);
    input.focus();

    input.onkeydown = async (e) => {
      if (e.key === 'Enter') {
        const name = input.value.trim();
        if (!name) return;
        input.disabled = true;
        await createSession(projectId, name);
        input.remove();
      } else if (e.key === 'Escape') {
        input.remove();
      }
    };

    input.onblur = () => {
      setTimeout(() => input.remove(), 150);
    };
  }

  // --- API calls ---
  async function createProject(name, cwd) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cwd }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to create project');
      return null;
    }
    return await res.json();
  }

  async function deleteProject(id) {
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
  }

  async function createSession(projectId, name) {
    const res = await fetch(`/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json();
      // Handle specific error codes
      let errorMessage = err.error || 'Failed to create session';
      if (err.code === 'WORKTREE_FAILED') {
        errorMessage = 'Failed to create worktree: ' + (err.error || 'Unknown error');
      }
      // Show error inline in sidebar near the project's session list
      const projGroup = projectListEl.querySelector(`[data-project-id="${projectId}"]`);
      if (projGroup) {
        const errEl = document.createElement('div');
        errEl.className = 'inline-error';
        errEl.textContent = errorMessage;
        projGroup.appendChild(errEl);
        setTimeout(() => errEl.remove(), 4000);
      }
      return null;
    }
    const session = await res.json();

    // Show warning toast if .worktrees not in .gitignore
    if (session.warning) {
      showToast(session.warning, 'warning', 6000);
    }

    attachSession(session.id);
    return session;
  }

  async function deleteSession(id, force = false) {
    const url = force ? `/api/sessions/${id}?force=true` : `/api/sessions/${id}`;
    const res = await fetch(url, { method: 'DELETE' });

    if (!res.ok) {
      const err = await res.json();
      if (err.code === 'DIRTY_WORKTREE') {
        // Show confirmation dialog for dirty worktree
        showConfirmDialog(
          'Uncommitted Changes',
          'This session has uncommitted changes. Delete anyway?',
          () => deleteSession(id, true) // Retry with force
        );
        return;
      }
      if (err.code === 'DIRTY_CHECK_FAILED') {
        showConfirmDialog(
          'Cannot Verify',
          'Unable to verify worktree status. Delete anyway?',
          () => deleteSession(id, true)
        );
        return;
      }
      // Show other errors as toast
      showToast(err.error || 'Failed to delete session', 'error');
      return;
    }

    if (activeSessionId === id) {
      activeSessionId = null;
      term.reset();
      noSession.classList.remove('hidden');
      rightPanel.classList.add('hidden');
    }
  }

  async function archiveSession(id, branchName, force = false) {
    const url = force
      ? `/api/sessions/${id}/archive?force=true`
      : `/api/sessions/${id}/archive`;
    const res = await fetch(url, { method: 'POST' });

    if (!res.ok) {
      const err = await res.json();
      if (err.code === 'DIRTY_WORKTREE') {
        showConfirmDialog(
          'Uncommitted Changes',
          'This session has uncommitted changes. Archive anyway?',
          () => archiveSession(id, branchName, true)
        );
        return;
      }
      if (err.code === 'DIRTY_CHECK_FAILED') {
        showConfirmDialog(
          'Cannot Verify',
          'Unable to verify worktree status. Archive anyway?',
          () => archiveSession(id, branchName, true)
        );
        return;
      }
      showToast(err.error || 'Failed to archive session', 'error');
      return;
    }

    const result = await res.json();
    const msg = result.branch
      ? `Session archived. Branch "${result.branch}" preserved.`
      : 'Session archived successfully.';
    showToast(msg, 'success');
  }

  async function restartSession(id) {
    const res = await fetch(`/api/sessions/${id}/restart`, { method: 'POST' });

    if (!res.ok) {
      const err = await res.json();
      if (err.code === 'WORKTREE_MISSING') {
        showToast('Worktree has been removed. Session cannot be restarted.', 'error');
      } else {
        showToast(err.error || 'Failed to restart session', 'error');
      }
    }
  }

  // --- Directory Browser ---
  let browsePath = '';
  let homedir = ''; // learned from first /api/browse response

  async function loadDir(dirPath) {
    const url = dirPath
      ? `/api/browse?path=${encodeURIComponent(dirPath)}`
      : '/api/browse';
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    browsePath = data.path;

    // Learn homedir from default browse (no path param)
    if (!homedir) homedir = data.path;

    // Render breadcrumbs relative to homedir
    dirBreadcrumbs.innerHTML = '';

    // ~ crumb (always clickable, navigates to homedir)
    const homeSpan = document.createElement('span');
    homeSpan.className = 'breadcrumb';
    homeSpan.textContent = '~';
    homeSpan.onclick = () => loadDir('');
    dirBreadcrumbs.appendChild(homeSpan);

    // Only show segments after the homedir prefix
    const relativePath = data.path.startsWith(homedir)
      ? data.path.slice(homedir.length)
      : data.path;
    const segments = relativePath.split('/').filter(Boolean);

    let accumulated = homedir;
    for (const seg of segments) {
      accumulated += '/' + seg;
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = '/';
      dirBreadcrumbs.appendChild(sep);

      const crumb = document.createElement('span');
      crumb.className = 'breadcrumb';
      crumb.textContent = seg;
      const pathForClick = accumulated;
      crumb.onclick = () => loadDir(pathForClick);
      dirBreadcrumbs.appendChild(crumb);
    }

    // Render directory list
    dirList.innerHTML = '';

    // Parent directory entry (only if we're deeper than homedir)
    if (data.parent && data.path !== homedir) {
      const parentLi = document.createElement('li');
      parentLi.textContent = '..';
      parentLi.onclick = () => loadDir(data.parent);
      dirList.appendChild(parentLi);
    }

    for (const d of data.dirs) {
      const li = document.createElement('li');
      li.textContent = d;
      li.onclick = () => loadDir(data.path + '/' + d);
      dirList.appendChild(li);
    }
  }

  // --- Modal ---
  function openModal() {
    modalProjectName.value = '';
    modalProjectPath.value = '';
    dirBrowser.classList.add('hidden');
    btnModalCreate.disabled = true;
    modalOverlay.classList.remove('hidden');
    modalProjectName.focus();
  }

  function closeModal() {
    modalOverlay.classList.add('hidden');
  }

  function updateCreateButton() {
    btnModalCreate.disabled = !(modalProjectName.value.trim() && modalProjectPath.value.trim());
  }

  btnAddProject.onclick = openModal;
  btnHomeAddProject.onclick = openModal;

  btnBrowse.onclick = () => {
    if (dirBrowser.classList.contains('hidden')) {
      dirBrowser.classList.remove('hidden');
      loadDir('');
    } else {
      dirBrowser.classList.add('hidden');
    }
  };

  btnSelectDir.onclick = () => {
    modalProjectPath.value = browsePath;
    dirBrowser.classList.add('hidden');
    updateCreateButton();
  };

  btnModalCancel.onclick = closeModal;

  btnModalCreate.onclick = async () => {
    const name = modalProjectName.value.trim();
    const cwd = modalProjectPath.value.trim();
    if (!name || !cwd) return;
    btnModalCreate.disabled = true;
    const proj = await createProject(name, cwd);
    if (proj) {
      expandedProjects.add(proj.id);
      closeModal();
    }
    updateCreateButton();
  };

  modalProjectName.oninput = updateCreateButton;

  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };

  document.onkeydown = (e) => {
    if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
      closeModal();
    }
  };

  // --- File Tree ---

  async function fetchDirEntries(relativePath) {
    if (!activeSessionId) return { dirs: [], files: [], hasMore: false };
    const params = new URLSearchParams({ sessionId: activeSessionId });
    if (relativePath) params.set('path', relativePath);
    const res = await fetch(`/api/browse?${params}`);
    if (!res.ok) return { dirs: [], files: [], hasMore: false };
    const data = await res.json();
    return {
      dirs: data.dirs || [],
      files: data.files || [],
      hasMore: data.hasMore || false,
    };
  }

  async function renderFileTreeDir(container, relativePath, depth) {
    container.innerHTML = '';

    const loading = document.createElement('div');
    loading.className = 'file-tree-loading';
    loading.textContent = 'Loading\u2026';
    container.appendChild(loading);

    const { dirs, files, hasMore } = await fetchDirEntries(relativePath);
    container.innerHTML = '';

    const indent = depth * 16;

    // Render directories first
    for (const dir of dirs) {
      const dirPath = relativePath ? relativePath + '/' + dir : dir;
      const item = document.createElement('div');

      const row = document.createElement('div');
      row.className = 'file-tree-item file-tree-folder';
      row.style.paddingLeft = indent + 'px';

      const arrow = document.createElement('span');
      arrow.className = 'file-tree-arrow';
      arrow.textContent = expandedDirs.has(dirPath) ? '\u25BC' : '\u25B6';

      const label = document.createElement('span');
      label.className = 'file-tree-label';
      label.textContent = dir;

      row.appendChild(arrow);
      row.appendChild(label);

      const children = document.createElement('div');
      children.className = 'file-tree-children';
      if (expandedDirs.has(dirPath)) {
        children.classList.add('expanded');
        renderFileTreeDir(children, dirPath, depth + 1);
      }

      row.onclick = () => {
        if (expandedDirs.has(dirPath)) {
          expandedDirs.delete(dirPath);
          arrow.textContent = '\u25B6';
          children.classList.remove('expanded');
          children.innerHTML = '';
        } else {
          expandedDirs.add(dirPath);
          arrow.textContent = '\u25BC';
          children.classList.add('expanded');
          renderFileTreeDir(children, dirPath, depth + 1);
        }
      };

      item.appendChild(row);
      item.appendChild(children);
      container.appendChild(item);
    }

    // Render files
    for (const file of files) {
      const filePath = relativePath ? relativePath + '/' + file : file;

      const row = document.createElement('div');
      row.className = 'file-tree-item';
      row.style.paddingLeft = (indent + 16) + 'px';

      const label = document.createElement('span');
      label.className = 'file-tree-label';
      label.textContent = file;
      label.title = filePath;

      row.appendChild(label);
      row.onclick = () => openFileTab(filePath, file);
      container.appendChild(row);
    }

    // "Show more" indicator when entries were truncated
    if (hasMore) {
      const more = document.createElement('div');
      more.className = 'file-tree-more';
      more.style.paddingLeft = indent + 'px';
      more.textContent = 'More entries not shown\u2026';
      container.appendChild(more);
    }

    // Show message if empty
    if (dirs.length === 0 && files.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'file-tree-loading';
      empty.textContent = 'Empty directory';
      container.appendChild(empty);
    }
  }

  function initFileTree() {
    if (!activeSessionId) {
      fileTreeEl.innerHTML = '';
      return;
    }
    expandedDirs.clear();
    renderFileTreeDir(fileTreeEl, '', 0);
  }

  // File tree collapse/expand toggle
  btnToggleFileTree.onclick = () => {
    const isCollapsed = fileTreeSection.classList.toggle('collapsed');
    btnToggleFileTree.innerHTML = isCollapsed ? '&#x25B6;' : '&#x25BC;';
    btnToggleFileTree.title = isCollapsed ? 'Expand file tree' : 'Collapse file tree';
    // Refit shell terminal after layout change
    requestAnimationFrame(() => {
      if (shellFitAddon) shellFitAddon.fit();
    });
  };

  // --- Tab System ---

  function renderTabs() {
    if (!activeSessionId) {
      tabBar.classList.remove('visible');
      return;
    }
    tabBar.classList.add('visible');
    tabList.innerHTML = '';

    // Claude tab (always first, never closeable)
    const claudeTab = document.createElement('div');
    claudeTab.className = 'tab' + (activeTabId === 'claude' ? ' active' : '');
    const claudeLabel = document.createElement('span');
    claudeLabel.className = 'tab-label';
    claudeLabel.textContent = 'Claude';
    claudeTab.appendChild(claudeLabel);
    claudeTab.onclick = () => switchTab('claude');
    tabList.appendChild(claudeTab);

    // File tabs
    for (const tab of openTabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (activeTabId === tab.id ? ' active' : '');
      el.title = tab.fullPath;

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = tab.filename;

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '\u00D7';
      close.onclick = (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      };

      el.appendChild(label);
      el.appendChild(close);
      el.onclick = () => switchTab(tab.id);
      tabList.appendChild(el);
    }
  }

  function switchTab(tabId) {
    activeTabId = tabId;
    renderTabs();

    const termWrapper = document.getElementById('terminal-wrapper');

    if (tabId === 'claude') {
      // Show terminal, hide file viewer
      termWrapper.style.display = '';
      termWrapper.style.inset = '32px 0 0 0';
      fileViewer.classList.add('hidden');
      term.focus();
      // Refit terminal since we changed inset
      requestAnimationFrame(() => { if (fitAddon) fitAddon.fit(); });
    } else {
      // Show file viewer, hide terminal
      termWrapper.style.display = 'none';
      fileViewer.classList.remove('hidden');

      const tab = openTabs.find(t => t.id === tabId);
      if (tab) {
        renderFileContent(tab);
      }
    }
  }

  function closeTab(tabId) {
    openTabs = openTabs.filter(t => t.id !== tabId);
    if (activeTabId === tabId) {
      activeTabId = openTabs.length > 0 ? openTabs[openTabs.length - 1].id : 'claude';
    }
    switchTab(activeTabId);
  }

  async function openFileTab(filePath, filename) {
    // Check if already open
    const existing = openTabs.find(t => t.id === filePath);
    if (existing) {
      switchTab(existing.id);
      return;
    }

    // Fetch file content
    const res = await fetch(`/api/file?sessionId=${activeSessionId}&path=${encodeURIComponent(filePath)}`);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to load file' }));
      showToast(err.error || 'Failed to load file', 'error');
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    let tab;

    if (contentType.includes('application/json')) {
      // Binary file response
      const data = await res.json();
      if (data.isBinary) {
        tab = { id: filePath, filename, fullPath: filePath, content: null, type: 'binary' };
      }
    } else {
      const content = await res.text();
      const ext = filename.split('.').pop().toLowerCase();
      const type = (ext === 'md' || ext === 'markdown') ? 'markdown' : 'text';
      tab = { id: filePath, filename, fullPath: filePath, content, type };
    }

    if (tab) {
      openTabs.push(tab);
      switchTab(tab.id);
    }
  }

  function renderFileContent(tab) {
    fileViewerPath.textContent = tab.fullPath;
    fileViewerContent.innerHTML = '';
    fileViewerContent.className = '';

    if (tab.type === 'binary') {
      fileViewerContent.className = 'binary-file';
      fileViewerContent.textContent = 'Binary file \u2014 not supported';
      return;
    }

    if (tab.type === 'markdown') {
      fileViewerContent.className = 'markdown-body';
      const rawHtml = marked.parse(tab.content);
      fileViewerContent.innerHTML = DOMPurify.sanitize(rawHtml);
      return;
    }

    // Plain text
    fileViewerContent.className = 'plain-text';
    fileViewerContent.textContent = tab.content;
  }

  // Refresh button handler
  fileViewerRefresh.onclick = async () => {
    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab || tab.type === 'binary') return;

    const res = await fetch(`/api/file?sessionId=${activeSessionId}&path=${encodeURIComponent(tab.fullPath)}`);
    if (!res.ok) {
      showToast('Failed to refresh file', 'error');
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (data.isBinary) {
        tab.type = 'binary';
        tab.content = null;
      }
    } else {
      tab.content = await res.text();
    }

    renderFileContent(tab);
  };

  // Keyboard shortcuts (only when terminal is NOT focused)
  document.addEventListener('keydown', (e) => {
    const inTerminal = terminalEl.contains(document.activeElement) ||
                       shellTerminalEl.contains(document.activeElement);
    if (inTerminal) return;

    if (e.altKey && e.key === 'Tab') {
      e.preventDefault();
      const allIds = ['claude', ...openTabs.map(t => t.id)];
      const idx = allIds.indexOf(activeTabId);
      const nextIdx = (idx + 1) % allIds.length;
      switchTab(allIds[nextIdx]);
    }

    if (e.altKey && e.key === 'w') {
      e.preventDefault();
      if (activeTabId !== 'claude') {
        closeTab(activeTabId);
      }
    }
  });

  // --- Right Panel Divider Drag ---

  const divider = document.getElementById('right-panel-divider');
  const shellSection = document.getElementById('shell-section');

  let isDragging = false;
  let rafPending = false;

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    e.preventDefault();
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    if (rafPending) return; // true single-frame debounce

    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const panelRect = rightPanel.getBoundingClientRect();
      const offset = e.clientY - panelRect.top;
      const total = panelRect.height;
      const minHeight = 100;

      if (offset < minHeight || total - offset < minHeight) return;

      const pct = (offset / total) * 100;
      fileTreeSection.style.flex = `0 0 ${pct}%`;

      if (shellFitAddon) shellFitAddon.fit();
    });
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (shellFitAddon) shellFitAddon.fit();
    }
  });

  // --- Init ---
  initTerminal();
  initShellTerminal();
  connect();
})();
