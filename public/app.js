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
            term.write(msg.data);
          }
          break;

        case 'replay-done':
          if (msg.sessionId === activeSessionId) {
            // Wait for write pipeline to drain, then wait for render before scrolling
            term.write('', () => {
              requestAnimationFrame(() => {
                term.scrollToBottom();
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
          }
          renderSidebar();
          break;

        case 'session-deleted':
          if (msg.sessionId === activeSessionId) {
            activeSessionId = null;
            term.reset();
            noSession.classList.remove('hidden');
          }
          break;

        case 'exited':
          // Session still exists, just re-render sidebar to update status dot
          renderSidebar();
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
    noSession.classList.add('hidden');

    wsSend(JSON.stringify({
      type: 'attach',
      sessionId,
      cols: term.cols,
      rows: term.rows,
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

        const sName = document.createElement('span');
        sName.className = 'session-name';
        sName.textContent = s.name;

        const time = document.createElement('span');
        time.className = 'session-time';
        time.textContent = relativeTime(s.createdAt);

        const sDel = document.createElement('button');
        sDel.className = 'session-delete';
        sDel.textContent = '\u00D7';
        sDel.title = 'Delete session';
        sDel.onclick = (e) => {
          e.stopPropagation();
          deleteSession(s.id);
        };

        li.appendChild(dot);
        li.appendChild(sName);
        li.appendChild(time);
        li.appendChild(sDel);

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
      // Show error inline in sidebar near the project's session list
      const projGroup = projectListEl.querySelector(`[data-project-id="${projectId}"]`);
      if (projGroup) {
        const errEl = document.createElement('div');
        errEl.className = 'inline-error';
        errEl.textContent = err.error || 'Failed to create session';
        projGroup.appendChild(errEl);
        setTimeout(() => errEl.remove(), 4000);
      }
      return null;
    }
    const session = await res.json();
    attachSession(session.id);
    return session;
  }

  async function deleteSession(id) {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (activeSessionId === id) {
      activeSessionId = null;
      term.reset();
      noSession.classList.remove('hidden');
    }
  }

  async function restartSession(id) {
    await fetch(`/api/sessions/${id}/restart`, { method: 'POST' });
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

  // --- Init ---
  initTerminal();
  connect();
})();
