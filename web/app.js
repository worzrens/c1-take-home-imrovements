let me = null;
let ws;
let activeConversation;
let conversations = [];

// Cursor into the history of the open conversation. `olderCursor` is the id of
// the oldest message on screen; anything older is fetched on demand.
let olderCursor = null;
let hasOlder = false;
let loadingOlder = false;

const $ = (id) => document.getElementById(id);

/* -------------------------------------------------------------------------- */
/* Session                                                                     */
/* -------------------------------------------------------------------------- */

// The token is in an httpOnly cookie, so script cannot read it and there is
// nothing to attach by hand. `credentials: 'same-origin'` is the default, but
// being explicit makes the dependency obvious.
const api = (path, init) => fetch(path, { credentials: 'same-origin', ...init });

const json = (payload) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

async function start() {
  const res = await api('/api/auth/me');
  if (res.ok) {
    me = await res.json();
    showApp();
  } else {
    showLogin();
  }
}

function showLogin() {
  $('login').hidden = false;
  $('app').hidden = true;
}

async function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;

  const who = $('whoami');
  who.textContent = `${me.name} · `;
  const out = document.createElement('button');
  out.id = 'logout';
  out.textContent = 'Sign out';
  out.onclick = logout;
  who.appendChild(out);

  await loadConversations();
}

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('loginError');
  err.hidden = true;

  const res = await api(
    '/api/auth/login',
    json({ email: $('loginEmail').value, password: $('loginPassword').value }),
  );
  if (!res.ok) {
    err.textContent = 'Invalid email or password.';
    err.hidden = false;
    return;
  }
  me = await res.json();
  $('loginPassword').value = '';
  await showApp();
};

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  if (ws) ws.close();
  me = null;
  conversations = [];
  activeConversation = null;
  $('conversations').innerHTML = '';
  $('messages').innerHTML = '';
  showLogin();
}

/* -------------------------------------------------------------------------- */
/* Conversations                                                               */
/* -------------------------------------------------------------------------- */

async function loadConversations() {
  const res = await api('/api/conversations');
  if (res.status === 401) return showLogin();
  conversations = await res.json();
  renderSidebar();
  connectWs();
}

function renderSidebar() {
  const list = $('conversations');
  list.innerHTML = '';
  for (const c of conversations) {
    const li = document.createElement('li');
    if (c.id === activeConversation) li.className = 'active';

    // Built as nodes, not innerHTML. The title is attacker-controlled: anyone
    // could create a conversation whose title was markup and it executed in the
    // browser of every participant when their sidebar rendered.
    const label = document.createElement('span');
    label.textContent = `${c.title} (${c.messageCount})`;
    li.appendChild(label);

    if (c.unread) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '●';
      li.appendChild(dot);
    }

    li.onclick = () => openConversation(c.id, c.title);
    list.appendChild(li);
  }
}

/* -------------------------------------------------------------------------- */
/* Real-time                                                                   */
/* -------------------------------------------------------------------------- */

function connectWs() {
  if (ws) ws.close();
  // wss: when the page is served over TLS. Hardcoding ws: broke the socket on
  // any HTTPS deployment, and mixed-content rules block it silently.
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${scheme}://${location.host}/`);

  ws.onopen = () => subscribe();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'message') onMessage(msg);
  };
}

// Sent on open and again whenever the known set changes, so a conversation
// created after connect starts receiving live traffic without a reload.
function subscribe() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', conversationIds: conversations.map((c) => c.id) }));
  }
}

function onMessage(msg) {
  const c = conversations.find((x) => x.id === msg.conversationId);
  if (c) c.messageCount += 1;
  if (msg.conversationId === activeConversation) {
    appendMessage(msg);
  } else if (c) {
    c.unread = true;
  }
  renderSidebar();
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

async function loadPage(conversationId, before) {
  const params = new URLSearchParams({ conversationId });
  if (before) params.set('before', before);
  const res = await api(`/api/messages?${params}`);
  if (!res.ok) return [];
  const page = await res.json();
  hasOlder = page.hasMore;
  olderCursor = page.nextBefore;
  return page.messages;
}

async function openConversation(id, title) {
  activeConversation = id;
  const c = conversations.find((x) => x.id === id);
  if (c) c.unread = false;
  renderSidebar();

  $('title').textContent = title;
  const pane = $('messages');
  pane.innerHTML = '';
  olderCursor = null;
  hasOlder = false;

  // Only the newest page. The history used to load in full, however long it was.
  for (const m of await loadPage(id, null)) appendMessage(m);
}

$('messages').addEventListener('scroll', async (e) => {
  const pane = e.target;
  if (pane.scrollTop > 0 || !hasOlder || loadingOlder || !activeConversation) return;

  loadingOlder = true;
  try {
    const heightBefore = pane.scrollHeight;
    const older = await loadPage(activeConversation, olderCursor);
    const batch = document.createDocumentFragment();
    for (const m of older) batch.appendChild(messageNode(m));
    pane.insertBefore(batch, pane.firstChild);
    // Keep the reader looking at the same message rather than jumping to the top.
    pane.scrollTop = pane.scrollHeight - heightBefore;
  } finally {
    loadingOlder = false;
  }
});

function messageNode(m) {
  const div = document.createElement('div');
  div.className = 'msg';
  if (m.body === null) {
    // The row exists but its body does not. Say so rather than showing a blank
    // line that reads as an empty message.
    div.textContent = `#${m.senderId}: (message unavailable)`;
    div.style.color = '#999';
  } else {
    div.textContent = `#${m.senderId}: ${m.body}`;
  }
  return div;
}

function appendMessage(m) {
  const pane = $('messages');
  pane.appendChild(messageNode(m));
  pane.scrollTop = pane.scrollHeight;
}

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('text');
  const body = input.value.trim();
  if (!body || !activeConversation) return;

  const err = $('sendError');
  err.hidden = true;

  // The input is not cleared until the server confirms. Clearing optimistically
  // meant a rejected send silently ate what you typed.
  try {
    const res = await api(
      '/api/messages',
      json({ conversationId: activeConversation, body, clientId: crypto.randomUUID() }),
    );

    if (res.status === 401) return showLogin();
    if (!res.ok) {
      err.textContent = 'Could not send. Try again.';
      err.hidden = false;
      return;
    }
    input.value = '';
  } catch {
    err.textContent = 'Network error. Try again.';
    err.hidden = false;
  }
};

$('newConv').onclick = async () => {
  const title = prompt('Conversation title?');
  if (!title) return;
  await api('/api/conversations', json({ title, participantIds: [2] }));
  await loadConversations();
  subscribe();
};

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

$('searchForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('search').value.trim();
  if (!q) return;
  const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) return;
  renderResults(q, await res.json());
};

function renderResults(q, results) {
  activeConversation = null;
  $('title').textContent = `Search: "${q}"`;
  const pane = $('messages');
  pane.innerHTML = '';
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'msg';
    empty.style.color = '#888';
    empty.textContent = 'No results.';
    pane.appendChild(empty);
    return;
  }
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'msg';
    div.style.cursor = 'pointer';
    const title = document.createElement('strong');
    title.textContent = r.conversationTitle ?? '#' + r.conversationId;
    div.append(title, ' — ' + (r.body ?? ''));
    div.onclick = () => openConversation(r.conversationId, r.conversationTitle ?? '#' + r.conversationId);
    pane.appendChild(div);
  }
}

start();
