const userId = 1;
let ws;
let activeConversation;
let conversations = [];

async function loadConversations() {
  const res = await fetch(`/api/conversations?userId=${userId}`);
  conversations = await res.json();
  renderSidebar();
  connectWs();
}

function renderSidebar() {
  const list = document.getElementById('conversations');
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

function connectWs() {
  if (ws) ws.close();
  ws = new WebSocket(`ws://${location.host}/`);
  ws.onopen = () =>
    ws.send(JSON.stringify({ type: 'subscribe', conversationIds: conversations.map((c) => c.id) }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== 'message') return;
    const c = conversations.find((x) => x.id === msg.conversationId);
    if (c) c.messageCount += 1;
    if (msg.conversationId === activeConversation) {
      appendMessage(msg);
    } else if (c) {
      c.unread = true;
    }
    renderSidebar();
  };
}

async function openConversation(id, title) {
  activeConversation = id;
  const c = conversations.find((x) => x.id === id);
  if (c) c.unread = false;
  renderSidebar();

  document.getElementById('title').textContent = title;
  const res = await fetch(`/api/messages?conversationId=${id}`);
  const messages = await res.json();
  const pane = document.getElementById('messages');
  pane.innerHTML = '';
  for (const m of messages) appendMessage(m);
}

function appendMessage(m) {
  const pane = document.getElementById('messages');
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
  pane.appendChild(div);
  pane.scrollTop = pane.scrollHeight;
}

document.getElementById('composer').onsubmit = async (e) => {
  e.preventDefault();
  const input = document.getElementById('text');
  const body = input.value.trim();
  if (!body || !activeConversation) return;
  input.value = '';
  await fetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: activeConversation,
      senderId: userId,
      body,
      clientId: crypto.randomUUID(),
    }),
  });
};

document.getElementById('newConv').onclick = async () => {
  const title = prompt('Conversation title?');
  if (!title) return;
  await fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, participantIds: [userId, 2] }),
  });
  await loadConversations();
};

document.getElementById('searchForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = document.getElementById('search').value.trim();
  if (!q) return;
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  renderResults(q, await res.json());
};

function renderResults(q, results) {
  activeConversation = null;
  document.getElementById('title').textContent = `Search: "${q}"`;
  const pane = document.getElementById('messages');
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

loadConversations();
