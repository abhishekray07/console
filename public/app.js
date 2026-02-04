// app.js
(function () {
  'use strict';

  // --- State ---
  let ws = null;
  let term = null;
  let fitAddon = null;
  let activeSessionId = null;
  let sessions = [];
  let reconnectDelay = 1000;

  // --- DOM refs ---
  const sessionList = document.getElementById('session-list');
  const terminalEl = document.getElementById('terminal');
  const noSession = document.getElementById('no-session');
  const newForm = document.getElementById('new-session-form');
  const btnNew = document.getElementById('btn-new');
  const btnCreate = document.getElementById('btn-create');
  const btnCancel = document.getElementById('btn-cancel');
  const inputName = document.getElementById('input-name');
  const inputCwd = document.getElementById('input-cwd');

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

  // --- Terminal setup ---
  function initTerminal() {
    term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background: '#000000',
        foreground: '#e0e0e0',
        cursor: '#e94560',
      },
    });

    fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalEl);
    fitAddon.fit();

    term.onData((data) => {
      if (activeSessionId) {
        wsSend(JSON.stringify({ type: 'input', data }));
      }
    });

    // Debounced resize handler
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
      console.log('WebSocket connected');
      reconnectDelay = 1000;
      // Re-attach if we had a session
      if (activeSessionId) {
        attachSession(activeSessionId);
      }
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'output':
          if (msg.sessionId === activeSessionId && msg.data) {
            term.write(msg.data);
          }
          break;

        case 'replay-done':
          break;

        case 'sessions':
          sessions = msg.sessions;
          renderSidebar();
          break;

        case 'exited':
          break;
      }
    };

    ws.onclose = () => {
      const jitter = reconnectDelay * (0.5 + Math.random());
      console.log(`WebSocket closed, reconnecting in ${Math.round(jitter)}ms...`);
      setTimeout(connect, jitter);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };

    ws.onerror = () => {
      ws.close();
    };
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
    sessionList.innerHTML = '';
    for (const s of sessions) {
      const li = document.createElement('li');
      if (s.id === activeSessionId) li.classList.add('active');

      // Status dot
      const dot = document.createElement('span');
      dot.className = 'status-dot';
      if (s.alive) {
        dot.classList.add('alive');
        dot.title = 'Running';
      } else if (s.claudeSessionId) {
        dot.classList.add('exited');
        dot.title = 'Exited (click to restart)';
      } else {
        dot.classList.add('no-resume');
        dot.title = 'Not resumable';
      }

      // Name
      const name = document.createElement('span');
      name.className = 'session-name';
      name.textContent = s.name;

      // Delete button
      const del = document.createElement('button');
      del.className = 'session-delete';
      del.textContent = '\u00d7';
      del.title = 'Delete session';
      del.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Delete session "${s.name}"?`)) {
          deleteSession(s.id);
        }
      };

      li.appendChild(dot);
      li.appendChild(name);
      li.appendChild(del);

      li.onclick = () => {
        if (!s.alive && s.claudeSessionId) {
          restartSession(s.id);
        }
        attachSession(s.id);
      };

      sessionList.appendChild(li);
    }
  }

  // --- API calls ---
  async function createSession(name, cwd) {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cwd }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to create session');
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

  // --- Form handlers ---
  btnNew.onclick = () => {
    newForm.classList.toggle('hidden');
    if (!newForm.classList.contains('hidden')) {
      inputName.focus();
    }
  };

  btnCancel.onclick = () => {
    newForm.classList.add('hidden');
    inputName.value = '';
    inputCwd.value = '';
  };

  btnCreate.onclick = async () => {
    const name = inputName.value.trim();
    const cwd = inputCwd.value.trim();
    if (!name || !cwd) return;
    await createSession(name, cwd);
    newForm.classList.add('hidden');
    inputName.value = '';
    inputCwd.value = '';
  };

  // Enter key in form
  inputCwd.onkeydown = (e) => {
    if (e.key === 'Enter') btnCreate.click();
  };
  inputName.onkeydown = (e) => {
    if (e.key === 'Enter') inputCwd.focus();
  };

  // --- Init ---
  initTerminal();
  connect();
})();
