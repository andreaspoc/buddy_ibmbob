const byId = (id) => document.getElementById(id);
const conversation = byId("conversation");
const messages = byId("messages");
const welcome = byId("welcome");
const promptInput = byId("prompt");
const form = byId("chat-form");
const sendButton = byId("send-button");
const stopButton = byId("stop-button");
const sidebar = byId("sidebar");
const slashMenu = byId("slash-menu");
const createDialog = byId("create-dialog");
const createForm = byId("create-form");
const previewDialog = byId("preview-dialog");
let previewPath = null;
let currentWorkspaceId = "legacy";
let currentUser = null;
let sessionsCatalog = [];
let currentProjectId = "";

let sessionId = null;
let controller = null;
let busy = false;
let skillsCatalog = [];
let modesCatalog = [];
let agentsCatalog = [];
let presentationTemplates = [];
let currentTemplateId = "buddy-starter-purple";
let activeAgent = null;
let agentContexts = {};
let activeMode = "agent";
let createKind = "skill";
let sessionTokensTotal = 0;
let sessionCostTotal = 0;

function reportUiError(action, error) {
  const status = byId("sidebar-status");
  status.textContent = `${action} failed. ${error?.message || "Please try again."}`;
  status.setAttribute("role", "alert");
  byId("sidebar-dot").className = "status-dot error";
  console.error(`${action} failed`, error);
}

function bobDeckFilename(text) {
  // Match fixed extensions first so a long basename without an extension is
  // scanned once, rather than retrying the whole basename at every character.
  for (const match of text.matchAll(/\.bobdeck/ig)) {
    let start = match.index;
    while (start > 0 && /[a-z0-9_-]/i.test(text[start - 1])) start--;
    if (start < match.index) return text.slice(start, match.index + match[0].length);
  }
  return null;
}

function skillPromptCommand(text) {
  if (!text.startsWith('/')) return null;
  const separator = text.search(/\s/);
  const name = text.slice(1, separator < 0 ? text.length : separator);
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return null;
  return [text, name, separator < 0 ? undefined : text.slice(separator).trimStart()];
}

function formatTokens(count) {
  if (!Number.isFinite(count) || count <= 0) return "0 tokens";
  if (count >= 1000000) return `${(count / 1000000).toFixed(2)}M tokens`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k tokens`;
  return `${count} tokens`;
}

function formatBobcoins(val) {
  if (!Number.isFinite(val) || val <= 0) return "0 Bobcoins";
  if (val < 0.001) return `${val.toFixed(4)} Bobcoins`;
  return `${val.toFixed(3)} Bobcoins`;
}

function updateTokenPill() {
  const tokensEl = byId("session-tokens-display");
  const costEl = byId("session-cost-display");
  const sepEl = byId("token-cost-sep");
  if (tokensEl) tokensEl.textContent = formatTokens(sessionTokensTotal);
  if (costEl && sessionCostTotal > 0) {
    costEl.textContent = formatBobcoins(sessionCostTotal);
    costEl.style.display = "inline";
    if (sepEl) sepEl.style.display = "inline";
  } else if (costEl) {
    costEl.style.display = "none";
    if (sepEl) sepEl.style.display = "none";
  }
}

function addTokenBadge(container, tokens, cost) {
  if (!tokens && !cost) return;
  let badge = container.querySelector(".stat-tokens-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "stat-tokens-badge";
    badge.title = "Buddy context tokens and Bobcoins";
    container.append(badge);
  }
  const parts = [];
  if (Number.isFinite(tokens) && tokens > 0) parts.push(formatTokens(tokens));
  if (Number.isFinite(cost) && cost > 0) parts.push(formatBobcoins(cost));
  badge.innerHTML = `<span class="stat-icon" aria-hidden="true">🪙</span> ${parts.join(" · ")}`;
}

function scrollToLatest() {
  conversation.scrollTop = conversation.scrollHeight;
}

function resizeInput() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
}

function setBusy(value) {
  busy = value;
  sendButton.classList.toggle("hidden", value);
  stopButton.classList.toggle("hidden", !value);
  sendButton.disabled = value;
  promptInput.disabled = value;
}

function createMessage(role, text = "", assistantName = "Buddy") {
  const message = document.createElement("article");
  message.className = `message ${role}`;

  if (role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = assistantName.slice(0, 1).toUpperCase();
    message.append(avatar);
  }

  const body = document.createElement("div");
  body.className = "message-body";
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "assistant" ? assistantName : "You";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  body.append(label, bubble);

  let meta = null;
  let tools = null;
  let work = null;
  let workItems = null;
  if (role === "assistant") {
    meta = document.createElement("div");
    meta.className = "message-meta";
    tools = document.createElement("div");
    tools.className = "tool-list";
    work = document.createElement("details");
    work.className = "work-panel";
    work.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "Work log · live";
    workItems = document.createElement("ol");
    workItems.className = "work-items";
    work.append(summary, workItems);
    body.append(meta, tools, work);
    message.classList.add("pending");
  }
  message.append(body);
  messages.append(message);
  scrollToLatest();
  return { message, bubble, rawText: text, meta, tools, work, workItems, workCount: 0, toolRows: new Map(), responseLogged: false };
}

function showResponse(view, complete = false) {
  if (complete && view.renderFrame) cancelAnimationFrame(view.renderFrame);
  if (!complete && view.renderFrame) return;
  const render = () => {
    view.renderFrame = null;
    if (window.BobRenderer) window.BobRenderer.renderMarkdown(view.bubble, view.rawText, complete);
    else view.bubble.textContent = view.rawText;
  };
  if (complete) render();
  else view.renderFrame = requestAnimationFrame(render);
}

function formatDetail(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}

function addWorkDetail(row, value, title) {
  const text = formatDetail(value);
  if (!text || text === "{}" || text === "[]") return;
  const details = document.createElement("details");
  details.className = "work-detail";
  const summary = document.createElement("summary");
  summary.textContent = `${title} · ${text.length.toLocaleString()} characters`;
  const pre = document.createElement("pre");
  pre.textContent = text;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "work-copy";
  copy.textContent = `Copy ${title.toLowerCase()}`;
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; }
    catch { copy.textContent = "Select the text to copy"; }
  });
  details.append(summary, copy, pre);
  row.append(details);
}

function setWorkState(row, state) {
  row.dataset.state = state;
  let badge = row.querySelector(".work-state");
  if (!badge) { badge = document.createElement("span"); badge.className = "work-state"; row.append(badge); }
  badge.textContent = state === "started" ? "Running" : state === "success" || state === "completed" ? "Done" : state === "error" || state === "failed" ? "Failed" : state;
}

function addWork(view, title, detail = null, id = null, detailTitle = "Details") {
  const row = document.createElement("li");
  row.className = "work-item";
  const time = document.createElement("span");
  time.className = "work-step";
  time.textContent = String(view.workCount + 1).padStart(2, "0");
  const label = document.createElement("strong");
  label.textContent = title;
  row.append(time, label);
  addWorkDetail(row, detail, detailTitle);
  view.workItems.append(row);
  view.workCount += 1;
  view.work.querySelector("summary").textContent = `Work log · ${view.workCount} steps`;
  if (id) view.toolRows.set(id, row);
  return row;
}

function addStatus(meta, value, isError = false) {
  let status = meta.querySelector(".message-status");
  if (!status) {
    status = document.createElement("span");
    status.className = "message-status";
    meta.append(status);
  }
  status.textContent = value;
  status.classList.toggle("error", isError);
}

function addSkill(meta, name) {
  if ([...meta.querySelectorAll(".skill-badge")].some((badge) => badge.textContent === name)) return;
  const badge = document.createElement("span");
  badge.className = "skill-badge";
  badge.textContent = name;
  meta.prepend(badge);
}

function addTool(tools, name, status) {
  let chip = [...tools.children].find((item) => item.dataset.name === name);
  if (!chip) {
    chip = document.createElement("span");
    chip.className = "tool-chip";
    chip.dataset.name = name;
    tools.append(chip);
  }
  chip.textContent = `${name} · ${status}`;
}

function handleEvent(event, view, agentSlug = null, replay = false) {
  switch (event.type) {
    case "start":
      addStatus(view.meta, "Working…");
      addWork(view, "Request started");
      break;
    case "status":
      addStatus(view.meta, event.message || "Working…");
      addWork(view, event.message || "Working…");
      break;
    case "delta":
      view.message.classList.remove("pending");
      view.rawText += event.text;
      showResponse(view);
      addStatus(view.meta, "Streaming…");
      if (!view.responseLogged) { addWork(view, "Response started"); view.responseLogged = true; }
      break;
    case "skill":
      addSkill(view.meta, event.name);
      addStatus(view.meta, "Using a skill…");
      addWork(view, `Skill: ${event.name}`);
      break;
    case "tool":
      addTool(view.tools, event.name, event.status);
      if (event.status === "started") {
        addStatus(view.meta, `Using ${event.name}…`);
        const row = addWork(view, event.name.replaceAll("_", " "), event.input, event.id, "Input");
        setWorkState(row, "started");
      } else {
        const row = event.id && view.toolRows.get(event.id);
        if (row) {
          setWorkState(row, event.status);
          addWorkDetail(row, event.output, "Output");
        } else {
          const row = addWork(view, event.name.replaceAll("_", " "), event.output, event.id, "Output");
          setWorkState(row, event.status);
        }
      }
      break;
    case "done": {
      if (agentSlug) agentContexts[agentSlug] = event.agent_context_id || agentContexts[agentSlug] || null;
      else sessionId = event.session_id || sessionId;
      for (const name of event.skills_used || []) addSkill(view.meta, name);
      const seconds = Number.isFinite(event.duration_ms) ? `${(event.duration_ms / 1000).toFixed(1)}s` : "Done";
      addStatus(view.meta, `Completed in ${seconds}`);
      addWork(view, `Completed in ${seconds}`);
      if (Number.isFinite(event.tokens) && event.tokens > 0) {
        addTokenBadge(view.meta, event.tokens, event.cost);
        sessionTokensTotal += event.tokens;
        if (Number.isFinite(event.cost)) sessionCostTotal += event.cost;
        updateTokenPill();
      } else if (Number.isFinite(event.cost) && event.cost > 0) {
        addTokenBadge(view.meta, null, event.cost);
        sessionCostTotal += event.cost;
        updateTokenPill();
      }
      view.work.open = false;
      view.work.querySelector("summary").textContent = `Work log · ${view.workCount} steps · ${seconds}`;
      if (!view.rawText) view.rawText = "The request completed without a text response.";
      showResponse(view, true);
      view.message.classList.remove("pending");
      if (!replay) {
        loadPages(view).catch(error => reportUiError("Refresh workspace pages", error));
        (async () => {
          try {
            if (view.bubble.querySelector(".bobdeck-viewer") || !window.BobRenderer?.createBobDeckViewer) return;
            const filename = bobDeckFilename(view.rawText || "");
            if (!filename) return;
            const deckRes = await fetch(`/presentation/deck?path=${encodeURIComponent(filename)}&session_id=${encodeURIComponent(currentWorkspaceId)}`);
            if (!deckRes.ok) throw new Error(`Could not load presentation (HTTP ${deckRes.status})`);
            const deckData = await deckRes.json();
            if (deckData?.slides?.length && !view.bubble.querySelector(".bobdeck-viewer")) {
              const viewer = window.BobRenderer.createBobDeckViewer(deckData);
              view.bubble.append(viewer);
              scrollToLatest();
            }
          } catch (error) {
            addStatus(view.meta, "Could not load the presentation preview. Try refreshing workspace pages.", true);
            console.error("Load presentation preview failed", error);
          }
        })().catch(error => reportUiError("Load presentation preview", error));
      }
      break;
    }
    case "error":
      addStatus(view.meta, event.message || "Request failed", true);
      addWork(view, `Error: ${event.message || "Request failed"}`);
      view.work.open = true;
      view.work.querySelector("summary").textContent = `Work log · Failed · ${view.workCount} steps`;
      if (!view.rawText) view.rawText = "The request could not be completed.";
      showResponse(view, true);
      view.message.classList.remove("pending");
      break;
  }
  scrollToLatest();
}

async function sendPrompt(rawPrompt) {
  const text = rawPrompt.trim();
  if (!text || busy || !currentUser) return;
  const modeCommand = text.match(/^\/mode\s+([a-z][a-z0-9-]*)$/);
  if (modeCommand) {
    selectMode(modeCommand[1]);
    promptInput.value = "";
    resizeInput();
    slashMenu.classList.add("hidden");
    return;
  }
  const agentCommand = text.match(/^\/agent\s+([a-z][a-z0-9-]*)$/);
  if (agentCommand) {
    selectAgent(agentCommand[1]);
    promptInput.value = "";
    resizeInput();
    return;
  }

  let skillName = null;
  let taskPrompt = text;
  const skillCommand = skillPromptCommand(text);
  if (skillCommand && skillsCatalog.some((skill) => skill.name === skillCommand[1])) {
    if (activeAgent) selectMode(activeMode);
    skillName = skillCommand[1];
    taskPrompt = (skillCommand[2] || "").trim();
    if (!taskPrompt) {
      promptInput.focus();
      return;
    }
  }
  slashMenu.classList.add("hidden");
  welcome.classList.add("hidden");
  sidebar.classList.remove("open");
  createMessage("user", text);
  const selectedAgent = activeAgent;
  const agent = agentsCatalog.find((item) => item.slug === selectedAgent);
  const view = createMessage("assistant", "", agent?.name || "Buddy");
  addStatus(view.meta, "Connecting…");
  promptInput.value = "";
  resizeInput();
  setBusy(true);
  controller = new AbortController();

  let terminalEvent = false;
  try {
    const response = await fetch("/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: taskPrompt,
        session_id: selectedAgent ? null : sessionId,
        skill_name: skillName,
        mode: activeMode,
        agent_name: selectedAgent,
        agent_context_id: selectedAgent ? agentContexts[selectedAgent] || null : null,
        workspace_id: currentWorkspaceId,
        template_id: activeMode === "presentation" ? currentTemplateId : null,
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        handleEvent(event, view, selectedAgent);
        if (event.type === "done" || event.type === "error") terminalEvent = true;
      }
    }
    if (buffer.trim()) {
      const event = JSON.parse(buffer);
      handleEvent(event, view, selectedAgent);
      if (event.type === "done" || event.type === "error") terminalEvent = true;
    }
    if (!terminalEvent) handleEvent({ type: "error", message: "The stream ended unexpectedly" }, view, selectedAgent);
  } catch (error) {
    const message = error.name === "AbortError" ? "Stopped" : error.message;
    handleEvent({ type: "error", message }, view, selectedAgent);
  } finally {
    controller = null;
    setBusy(false);
    promptInput.focus();
    await loadSessions().catch(error => reportUiError("Refresh conversations", error));
  }
}

async function startNewChat() {
  if (busy) return;
  sessionTokensTotal = 0;
  sessionCostTotal = 0;
  updateTokenPill();
  const response = await fetch(`/sessions${currentProjectId ? `?project_id=${encodeURIComponent(currentProjectId)}` : ""}`, { method: "POST" });
  if (!response.ok) throw new Error(`Could not create conversation (HTTP ${response.status})`);
  const created = await response.json();
  await loadSessions();
  await switchSession(created.id);
}

async function switchSession(id) {
  if (busy) return;
  sessionTokensTotal = 0;
  sessionCostTotal = 0;
  updateTokenPill();
  currentWorkspaceId = id;
  currentProjectId = sessionsCatalog.find(item => item.id === id)?.project_id || "";
  byId("project-select").value = currentProjectId;
  byId("open-project").classList.toggle("hidden", !currentProjectId);
  byId("workspace-note").textContent = currentProjectId ? "Conversations in this project share repository files. Each conversation keeps its own history and work log." : "Personal conversations have separate files. Select a project to work with a repository.";
  byId("prompt").placeholder = currentProjectId ? "Ask Buddy about this project…" : "Ask Buddy anything — no skill selection needed…";
  sessionStorage.setItem("bob_workspace_id", id);
  sessionId = null;
  agentContexts = {};
  messages.replaceChildren();
  welcome.classList.remove("hidden");
  sidebar.classList.remove("open");
  promptInput.value = "";
  resizeInput();
  const response = await fetch(`/sessions/${encodeURIComponent(id)}/history`);
  if (response.ok) {
    const history = await response.json();
    let view = null;
    let agentSlug = null;
    for (const event of history) {
      if (event.type === "request") {
        welcome.classList.add("hidden");
        createMessage("user", event.display_prompt || event.prompt);
        agentSlug = event.agent_name;
        const agent = agentsCatalog.find((item) => item.slug === agentSlug);
        view = createMessage("assistant", "", agent?.name || "Buddy");
      } else if (view) {
        handleEvent(event, view, agentSlug, true);
      }
    }
  }
  for (const button of byId("session-list").querySelectorAll(".mode-item")) {
    button.classList.toggle("active", button.dataset.id === id);
  }
  await loadPages();
  promptInput.focus();
}

async function loadSessions() {
  const response = await fetch("/sessions");
  if (!response.ok) return [];
  sessionsCatalog = await response.json();
  const list = byId("session-list");
  list.replaceChildren();
  for (const session of sessionsCatalog) {
    if ((session.project_id || "") !== currentProjectId) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mode-item";
    button.dataset.id = session.id;
    button.textContent = session.title;
    button.classList.toggle("active", session.id === currentWorkspaceId);
    button.addEventListener("click", () => switchSession(session.id).catch(error => reportUiError("Open conversation", error)));
    list.append(button);
  }
  return sessionsCatalog;
}

async function loadSkills() {
  const list = byId("skill-list");
  try {
    const response = await fetch("/skills");
    if (!response.ok) throw new Error("Could not load skills");
    const skills = await response.json();
    skillsCatalog = skills;
    byId("skill-count").textContent = skills.length;
    list.replaceChildren();
    if (!skills.length) {
      list.textContent = "No project skills found.";
      return;
    }
    for (const skill of skills) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "skill-item";
      const top = document.createElement("span");
      top.className = "skill-item-top";
      const symbol = document.createElement("span");
      symbol.className = "skill-symbol";
      symbol.textContent = "✦";
      const name = document.createElement("span");
      name.textContent = skill.name;
      top.append(symbol, name);
      const description = document.createElement("span");
      description.className = "skill-description";
      description.textContent = skill.description;
      button.append(top, description);
      button.addEventListener("click", () => {
        promptInput.value = `/${skill.name} `;
        resizeInput();
        sidebar.classList.remove("open");
        slashMenu.classList.add("hidden");
        promptInput.focus();
        promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
      });
      list.append(button);
    }
  } catch (error) {
    list.textContent = error.message;
  }
}

function selectMode(slug, autoOpenPicker = true) {
  const mode = modesCatalog.find((item) => item.slug === slug);
  if (!mode) return;
  activeMode = slug;
  activeAgent = null;
  byId("active-mode").textContent = `${mode.name} mode`;
  byId("prompt-label").textContent = "Message Buddy";

  const banner = byId("presentation-banner");
  if (slug === "presentation") {
    if (banner) banner.classList.remove("hidden");
    promptInput.placeholder = "Describe the presentation you want Buddy to create (e.g. Q3 Executive Summary)...";
    chooseTemplate(currentTemplateId);
    if (autoOpenPicker) {
      const dialog = byId("presentation-dialog");
      if (dialog && !dialog.open) dialog.showModal();
    }
  } else {
    if (banner) banner.classList.add("hidden");
    promptInput.placeholder = "Ask Buddy anything — no skill selection needed…";
  }

  for (const button of byId("mode-list").querySelectorAll(".mode-item")) {
    button.classList.toggle("active", button.dataset.slug === slug);
  }
  for (const button of byId("agent-list").querySelectorAll(".mode-item")) button.classList.remove("active");
  sidebar.classList.remove("open");
  slashMenu.classList.add("hidden");
  promptInput.focus();
}

function selectAgent(slug) {
  const agent = agentsCatalog.find((item) => item.slug === slug);
  if (!agent) return;
  activeAgent = slug;
  byId("active-mode").textContent = `${agent.name} · A2A`;
  byId("prompt-label").textContent = `Message ${agent.name}`;
  promptInput.placeholder = `Message ${agent.name}…`;
  for (const button of byId("mode-list").querySelectorAll(".mode-item")) button.classList.remove("active");
  for (const button of byId("agent-list").querySelectorAll(".mode-item")) {
    button.classList.toggle("active", button.dataset.slug === slug);
  }
  sidebar.classList.remove("open");
  slashMenu.classList.add("hidden");
  promptInput.focus();
}

async function loadMcps() {
  const list = byId("mcp-list");
  try {
    const response = await fetch("/mcps");
    if (!response.ok) throw new Error("Could not load MCP servers");
    const servers = await response.json();
    byId("mcp-count").textContent = servers.length;
    list.replaceChildren();
    for (const server of servers) {
      const item = document.createElement("div");
      item.className = "integration-item";
      const name = document.createElement("strong");
      name.textContent = server.name;
      const detail = document.createElement("small");
      detail.textContent = `${server.transport.toUpperCase()} · ${server.target}`;
      item.append(name, detail);
      list.append(item);
    }
    if (!servers.length) list.innerHTML = '<div class="muted-small">No MCP servers yet.</div>';
  } catch (error) { list.textContent = error.message; }
}

async function loadMicrosoftStatus() {
  const container = byId("ms-status-box");
  if (!container) return;
  try {
    const res = await fetch("/auth/microsoft/status");
    if (!res.ok) return;
    const status = await res.json();
    container.replaceChildren();
    if (status.connected) {
      const item = document.createElement("div");
      item.className = "integration-item";
      item.style.borderLeft = "3px solid #00a4ef";
      item.style.padding = "8px 10px";
      item.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:6px;">
            <svg width="14" height="14" viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
            <strong style="font-size:12px;"></strong>
          </div>
          <button id="ms-disconnect-btn" type="button" style="background:none;border:none;color:#f87171;font-size:11px;cursor:pointer;">Disconnect</button>
        </div>
        <small style="color:#c4b5fd;display:block;margin-top:2px;word-break:break-all;"></small>
        <small style="color:#94a3b8;font-size:10px;display:block;margin-top:2px;">Tools active: Mail, Calendar, OneDrive</small>
      `;
      item.querySelector('strong').textContent = status.name || 'Connected';
      item.querySelector('small').textContent = status.account || 'Active session';
      container.append(item);
      item.querySelector("#ms-disconnect-btn")?.addEventListener("click", async () => {
        await fetch("/auth/microsoft/disconnect", { method: "POST" });
        await loadMicrosoftStatus();
        await loadMcps();
      });
    } else {
      const link = document.createElement("a");
      link.href = "/auth/microsoft/login";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "mode-item";
      link.style.display = "flex";
      link.style.alignItems = "center";
      link.style.gap = "8px";
      link.style.textDecoration = "none";
      link.style.background = "rgba(255,255,255,0.04)";
      link.style.border = "1px solid rgba(255,255,255,0.1)";
      link.style.borderRadius = "6px";
      link.style.padding = "8px 10px";
      link.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 21 21" style="flex-shrink:0;"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
        <div style="flex:1;">
          <div style="font-size:12px;font-weight:500;color:#f1f5f9;">Connect Microsoft 365</div>
          <small style="color:#94a3b8;font-size:10px;display:block;">${status.configured ? "Sign in for Mail, Calendar & Files" : "Requires AZURE_CLIENT_ID"}</small>
        </div>
      `;
      container.append(link);
    }
  } catch (err) {
    console.error("Failed to load Microsoft status", err);
  }
}

async function loadAgents() {
  const list = byId("agent-list");
  try {
    const response = await fetch("/agents");
    if (!response.ok) throw new Error("Could not load A2A agents");
    agentsCatalog = await response.json();
    byId("agent-count").textContent = agentsCatalog.length;
    list.replaceChildren();
    for (const agent of agentsCatalog) {
      const row = document.createElement("div");
      row.className = "agent-row";

      const button = document.createElement("button");
      button.className = "mode-item";
      button.type = "button";
      button.dataset.slug = agent.slug;
      button.textContent = agent.name;
      const description = document.createElement("small");
      description.textContent = agent.description || agent.endpoint;
      button.append(description);
      button.addEventListener("click", () => selectAgent(agent.slug));

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "agent-action-btn";
      editBtn.title = "Configure agent";
      editBtn.innerHTML = "⚙";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditAgent(agent);
      });

      row.append(button, editBtn);
      list.append(row);
    }
    if (!agentsCatalog.length) list.innerHTML = '<div class="muted-small">No A2A agents yet.</div>';
    if (activeAgent) selectAgent(activeAgent);
  } catch (error) { list.textContent = error.message; }
}

function openEditAgent(agent) {
  const dialog = byId("agent-edit-dialog");
  byId("edit-agent-slug").value = agent.slug || "";
  byId("edit-agent-name").value = agent.name || "";
  byId("edit-agent-desc").value = agent.description || "";
  byId("edit-agent-endpoint").value = agent.endpoint || "";
  byId("edit-agent-api-key").value = agent.api_key || "";
  byId("edit-agent-api-key-header").value = agent.api_key_header || "x-api-key";
  byId("edit-agent-card-url").value = agent.card_url || "";
  byId("agent-edit-error").textContent = "";
  dialog.showModal();
}

async function saveEditedAgent(event) {
  event.preventDefault();
  const slug = byId("edit-agent-slug").value;
  const saveBtn = byId("agent-edit-save");
  const errBox = byId("agent-edit-error");
  saveBtn.disabled = true;
  errBox.textContent = "";

  const payload = {
    name: byId("edit-agent-name").value.trim(),
    description: byId("edit-agent-desc").value.trim(),
    endpoint: byId("edit-agent-endpoint").value.trim(),
    api_key: byId("edit-agent-api-key").value.trim(),
    api_key_header: byId("edit-agent-api-key-header").value.trim() || "x-api-key",
    card_url: byId("edit-agent-card-url").value.trim(),
  };

  try {
    const response = await fetch(`/agents/${encodeURIComponent(slug)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.detail || "Failed to update agent");
    }
    byId("agent-edit-dialog").close();
    await loadAgents();
  } catch (err) {
    errBox.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
}

async function deleteSelectedAgent() {
  const slug = byId("edit-agent-slug").value;
  const name = byId("edit-agent-name").value;
  if (!confirm(`Are you sure you want to delete "${name || slug}"?`)) return;

  const deleteBtn = byId("agent-delete-btn");
  const errBox = byId("agent-edit-error");
  deleteBtn.disabled = true;
  errBox.textContent = "";

  try {
    const response = await fetch(`/agents/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 204) {
      const result = await response.json();
      throw new Error(result.detail || "Failed to delete agent");
    }
    byId("agent-edit-dialog").close();
    if (activeAgent === slug) {
      selectMode("agent");
    }
    await loadAgents();
  } catch (err) {
    errBox.textContent = err.message;
  } finally {
    deleteBtn.disabled = false;
  }
}

async function loadModes() {
  const list = byId("mode-list");
  try {
    const response = await fetch("/modes");
    if (!response.ok) throw new Error("Could not load modes");
    modesCatalog = await response.json();
    byId("mode-count").textContent = modesCatalog.length;
    list.replaceChildren();
    for (const mode of modesCatalog) {
      const button = document.createElement("button");
      button.className = "mode-item";
      button.type = "button";
      button.dataset.slug = mode.slug;
      button.textContent = mode.name;
      const description = document.createElement("small");
      description.textContent = mode.description;
      button.append(description);
      button.addEventListener("click", () => selectMode(mode.slug));
      list.append(button);
    }
    selectMode(activeMode, false);
  } catch (error) {
    list.textContent = error.message;
  }
}

async function loadPresentationTemplates() {
  const grid = byId("template-grid");
  try {
    const res = await fetch("/presentation/templates");
    if (!res.ok) throw new Error("Could not load templates");
    presentationTemplates = await res.json();
    renderTemplateGrid();
  } catch (err) {
    if (grid) {
      const message = document.createElement("div");
      message.className = "muted-small";
      message.textContent = err.message;
      grid.replaceChildren(message);
    }
  }
}

function renderTemplateGrid() {
  const grid = byId("template-grid");
  if (!grid) return;
  grid.replaceChildren();

  for (const t of presentationTemplates) {
    const card = document.createElement("div");
    card.className = "template-card" + (t.id === currentTemplateId ? " active" : "");
    card.dataset.id = t.id;

    const top = document.createElement("div");
    top.className = "template-card-top";

    const titleWrap = document.createElement("div");
    const title = document.createElement("h4");
    title.className = "template-card-title";
    title.textContent = t.title;

    const brand = document.createElement("div");
    brand.className = "template-card-brand";
    brand.textContent = t.brand;
    titleWrap.append(title, brand);

    const badge = document.createElement("span");
    badge.className = "template-card-badge";
    badge.textContent = `${t.slidesCount} slides`;
    top.append(titleWrap, badge);

    const swatches = document.createElement("div");
    swatches.className = "template-swatches";
    const colors = [t.colors.primary, t.colors.secondary, t.colors.accent, t.colors.background];
    for (const c of colors) {
      const sw = document.createElement("div");
      sw.className = "template-swatch";
      sw.style.backgroundColor = c;
      swatches.append(sw);
    }

    const layouts = document.createElement("div");
    layouts.className = "template-layouts";
    for (const prev of (t.slidePreviews || []).slice(0, 3)) {
      const tag = document.createElement("span");
      tag.className = "template-layout-tag";
      tag.textContent = prev.title || prev.layout;
      layouts.append(tag);
    }

    card.append(top, swatches, layouts);
    card.addEventListener("click", () => {
      chooseTemplate(t.id);
      byId("presentation-dialog")?.close();
      promptInput.focus();
    });

    grid.append(card);
  }
}

function chooseTemplate(templateId) {
  const template = presentationTemplates.find(t => t.id === templateId) || presentationTemplates[0];
  if (!template) return;
  currentTemplateId = template.id;
  const titleEl = byId("current-template-title");
  if (titleEl) titleEl.textContent = template.title;
  renderTemplateGrid();
}

function slashOption(label, description, kind, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "slash-option";
  button.setAttribute("role", "option");
  const content = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = label;
  const detail = document.createElement("small");
  detail.textContent = description;
  content.append(title, detail);
  const tag = document.createElement("span");
  tag.className = "slash-option-kind";
  tag.textContent = kind;
  button.append(content, tag);
  button.addEventListener("click", action);
  return button;
}

function menuHeading(text) {
  const heading = document.createElement("div");
  heading.className = "slash-menu-heading";
  heading.textContent = text;
  return heading;
}

function renderSlashMenu(filter = "") {
  slashMenu.replaceChildren();
  const query = filter.toLowerCase();
  const matchingSkills = skillsCatalog.filter((skill) => skill.name.includes(query));
  const matchingModes = modesCatalog.filter((mode) => `mode ${mode.slug}`.includes(query));
  const matchingAgents = agentsCatalog.filter((agent) => `agent ${agent.slug}`.includes(query));
  if (matchingSkills.length) {
    slashMenu.append(menuHeading("SKILLS"));
    for (const skill of matchingSkills) {
      slashMenu.append(slashOption(`/${skill.name}`, skill.description, "SKILL", () => {
        promptInput.value = `/${skill.name} `;
        resizeInput();
        slashMenu.classList.add("hidden");
        promptInput.focus();
      }));
    }
  }
  if (matchingModes.length) {
    slashMenu.append(menuHeading("MODES"));
    for (const mode of matchingModes) {
      slashMenu.append(slashOption(`/mode ${mode.slug}`, mode.description, "MODE", () => {
        selectMode(mode.slug);
        promptInput.value = "";
        resizeInput();
      }));
    }
  }
  if (matchingAgents.length) {
    slashMenu.append(menuHeading("A2A AGENTS"));
    for (const agent of matchingAgents) {
      slashMenu.append(slashOption(`/agent ${agent.slug}`, agent.description || agent.endpoint, "A2A", () => {
        selectAgent(agent.slug);
        promptInput.value = "";
        resizeInput();
      }));
    }
  }
  slashMenu.classList.toggle("hidden", !slashMenu.children.length);
}

function openCreateDialog(kind) {
  createKind = kind;
  createForm.reset();
  byId("form-error").textContent = "";
  byId("dialog-title").textContent = {skill:"Add a skill", mode:"Add a mode", mcp:"Add an MCP server", agent:"Add an A2A agent"}[kind];
  byId("dialog-intro").textContent = {
    skill:"Create a project skill Buddy can activate in future conversations.",
    mode:"Create a project mode with its own role and allowed tools.",
    mcp:"Connect Buddy to an MCP server.",
    agent:"Connect to another agent by its Agent Card.",
  }[kind];
  byId("skill-fields").classList.toggle("hidden", kind !== "skill");
  byId("mode-fields").classList.toggle("hidden", kind !== "mode");
  byId("mcp-fields").classList.toggle("hidden", kind !== "mcp");
  byId("agent-fields").classList.toggle("hidden", kind !== "agent");
  for (const field of byId("skill-fields").querySelectorAll("textarea")) field.required = kind === "skill";
  for (const field of byId("mode-fields").querySelectorAll("input:not([type=checkbox]), textarea[name=mode_description], textarea[name=role_definition]")) field.required = kind === "mode";
  byId("mcp-transport").value = "http";
  updateMcpFields();
  createForm.elements.card_url.required = kind === "agent";
  createDialog.showModal();
  byId("item-slug").focus();
}

function updateMcpFields() {
  const stdio = byId("mcp-transport").value === "stdio";
  byId("mcp-url-field").classList.toggle("hidden", stdio);
  byId("mcp-http-fields").classList.toggle("hidden", stdio);
  byId("mcp-stdio-fields").classList.toggle("hidden", !stdio);
  byId("mcp-key-prefix-field").classList.toggle("hidden", stdio);
  byId("mcp-key-name").placeholder = stdio ? "API_KEY" : "Authorization";
  createForm.elements.mcp_key_prefix.placeholder = "Bearer ";
  createForm.elements.mcp_url.required = createKind === "mcp" && !stdio;
  createForm.elements.mcp_command.required = createKind === "mcp" && stdio;
}

function parseJsonField(data, name, expected) {
  const raw = String(data.get(name) || "").trim();
  if (!raw) return expected === "array" ? [] : {};
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error(`${name.replaceAll("_", " ")} must be valid JSON`); }
  if (expected === "array" && (!Array.isArray(value) || !value.every((item) => typeof item === "string"))) {
    throw new Error(`${name.replaceAll("_", " ")} must be an array of strings`);
  }
  if (expected === "object" && (Array.isArray(value) || !value || typeof value !== "object" || Object.values(value).some((item) => typeof item !== "string"))) {
    throw new Error(`${name.replaceAll("_", " ")} must be an object of string values`);
  }
  return value;
}

async function saveCreatedItem(event) {
  event.preventDefault();
  const data = new FormData(createForm);
  const slug = String(data.get("slug") || "").trim();
  const endpoint = {skill:"/skills", mode:"/modes", mcp:"/mcps", agent:"/agents"}[createKind];
  const saveButton = byId("save-item");
  saveButton.disabled = true;
  byId("form-error").textContent = "";
  try {
    const payload = createKind === "skill" ? {
      name: slug, description: String(data.get("skill_description") || "").trim(), instructions: String(data.get("skill_instructions") || "").trim(),
    } : createKind === "mode" ? {
        slug,
        name: String(data.get("mode_name") || "").trim(),
        description: String(data.get("mode_description") || "").trim(),
        role_definition: String(data.get("role_definition") || "").trim(),
        instructions: String(data.get("mode_instructions") || "").trim(),
        groups: data.getAll("group"),
      } : createKind === "mcp" ? {
        name: slug,
        transport: String(data.get("mcp_transport")),
        url: String(data.get("mcp_url") || "").trim(),
        command: String(data.get("mcp_command") || "").trim(),
        args: parseJsonField(data, "mcp_args", "array"),
        parameters: parseJsonField(data, "mcp_parameters", "object"),
        headers: parseJsonField(data, "mcp_headers", "object"),
        env: parseJsonField(data, "mcp_env", "object"),
        api_key: String(data.get("mcp_api_key") || ""),
        api_key_name: String(data.get("mcp_key_name") || "").trim() || (data.get("mcp_transport") === "stdio" ? "API_KEY" : "Authorization"),
        api_key_prefix: String(data.get("mcp_key_prefix") || "") || "Bearer ",
      } : {
        slug,
        card_url: String(data.get("card_url") || "").trim(),
        endpoint_override: String(data.get("endpoint_override") || "").trim(),
        api_key: String(data.get("agent_api_key") || "").trim(),
        api_key_header: String(data.get("agent_api_key_header") || "").trim() || "x-api-key",
      };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) {
      const detail = result.detail;
      throw new Error(typeof detail === "string" ? detail : detail?.[0]?.msg || "Could not create item");
    }
    createDialog.close();
    if (createKind === "skill") await loadSkills();
    else if (createKind === "mode") {
      await loadModes();
      selectMode(slug);
    } else if (createKind === "mcp") await loadMcps();
    else { await loadAgents(); selectAgent(slug); }
  } catch (error) {
    byId("form-error").textContent = error.message;
  } finally {
    saveButton.disabled = false;
  }
}

async function loadPages(view = null) {
  const list = byId("page-list");
  try {
    const response = await fetch(`/workspace/pages?session_id=${encodeURIComponent(currentWorkspaceId)}`);
    if (!response.ok) throw new Error("Could not load workspace pages");
    const pages = await response.json();
    list.replaceChildren();
    if (!pages.length) {
      const empty = document.createElement("div");
      empty.className = "muted-small";
      empty.textContent = "No HTML pages yet.";
      list.append(empty);
    }
    for (const page of pages) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mode-item page-item";
      button.textContent = page.path;
      const hint = document.createElement("small");
      hint.textContent = "Preview page";
      button.append(hint);
      button.addEventListener("click", () => openPreview(page.path).catch(error => reportUiError("Open preview", error)));
      list.append(button);
    }
    if (view && pages.length) {
      const file = pages.find((p) => (view.rawText || "").includes(p.path));
      if (file) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "preview-link";
        button.textContent = `Preview ${file.path} ↗`;
        button.addEventListener("click", () => openPreview(file.path).catch(error => reportUiError("Open preview", error)));
        view.meta.append(button);
        addWork(view, `Workspace page available: ${file.path}`);
      }
    }
    return pages;
  } catch (error) {
    list.textContent = error.message;
    return [];
  }
}

async function openPreview(path) {
  previewPath = path;
  const frame = byId("preview-frame");
  const code = byId("preview-code");
  byId("preview-title").textContent = path;
  frame.srcdoc = "<p style='font-family:sans-serif;padding:2rem'>Loading preview…</p>";
  code.textContent = "";
  code.classList.add("hidden");
  frame.classList.remove("hidden");
  byId("preview-source").textContent = "View source";
  if (!previewDialog.open) previewDialog.showModal();
  try {
    const response = await fetch(`/workspace/page?session_id=${encodeURIComponent(currentWorkspaceId)}&path=${encodeURIComponent(path)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Could not load preview");
    frame.srcdoc = data.html;
    code.textContent = data.html;
  } catch (error) {
    frame.srcdoc = `<p style="font-family:sans-serif;padding:2rem">${error.message.replaceAll("<", "&lt;")}</p>`;
  }
}

async function checkHealth() {
  const dot = byId("sidebar-dot");
  const status = byId("sidebar-status");
  try {
    const response = await fetch("/health");
    const data = await response.json();
    if (!response.ok || !data.ok || !data.bob_key_present) throw new Error("Buddy key unavailable");
    dot.className = "status-dot ready";
    status.textContent = "Buddy is ready";
  } catch (error) {
    dot.className = "status-dot error";
    status.textContent = error.message;
  }
}

let authMode = "login";
let authOptions = { keycloak_configured: false, local_login_enabled: false };

function showAuth(mode) {
  authMode = mode;
  if (!authOptions.local_login_enabled || (authOptions.keycloak_configured && mode === "register")) mode = "login";
  authMode = mode;
  const creating = mode !== "login";
  byId("auth-local").classList.toggle("hidden", !authOptions.local_login_enabled);
  byId("auth-keycloak").classList.toggle("hidden", !authOptions.keycloak_configured);
  for (const input of byId("auth-local").querySelectorAll("input")) input.disabled = !authOptions.local_login_enabled;
  byId("auth-title").textContent = mode === "setup" ? "Create the first account" : mode === "register" ? "Create your account" : "Sign in";
  byId("auth-intro").textContent = mode === "setup"
    ? "This first account manages other users. Use a password of at least 12 characters."
    : mode === "register" ? "Create your private workspace with Buddy. Use a password of at least 12 characters."
    : "Sign in to your private Buddy workspace.";
  byId("auth-error").textContent = "";
  byId("auth-form").elements.password.autocomplete = creating ? "new-password" : "current-password";
  byId("auth-form").elements.password.minLength = creating ? 12 : 0;
  byId("auth-form").elements.confirm_password.required = creating;
  byId("auth-confirm-field").classList.toggle("hidden", !creating);
  byId("auth-submit").textContent = creating ? "Create account" : "Sign in";
  byId("auth-switch").innerHTML = authOptions.keycloak_configured || mode === "setup" ? "" : mode === "register"
    ? 'Already have an account? <a href="/">Sign in</a>'
    : 'New here? <a href="/register">Create an account</a>';
  byId("auth-overlay").classList.remove("hidden");
  if (authOptions.keycloak_configured) {
    byId("auth-intro").textContent = "Sign in with your company account.";
    byId("auth-keycloak").focus();
  } else if (authOptions.local_login_enabled) byId("auth-form").elements.username.focus();
  else byId("auth-intro").textContent = "Sign-in is not configured. Contact your administrator.";
  if (new URLSearchParams(location.search).has("keycloak_error")) byId("auth-error").textContent = "Unable to sign in. Please try again.";
}

async function initApp(user) {
  currentUser = user;
  byId("auth-overlay").classList.add("hidden");
  byId("signed-in-user").textContent = user.display_name || user.username;
  byId("add-user").classList.toggle("hidden", !user.is_admin);
  await Promise.all([loadSkills(), loadModes(), loadMcps(), loadMicrosoftStatus(), loadAgents(), checkHealth(), loadProjects(), loadPresentationTemplates()]);
  const sessions = await loadSessions();
  const saved = sessionStorage.getItem("bob_workspace_id");
  const selected = sessions.find((item) => item.id === saved)?.id || sessions[0]?.id;
  if (selected) await switchSession(selected);
  else await startNewChat();
  await loadSessions();
}

async function checkAuth() {
  try {
    const response = await fetch("/auth/status");
    if (!response.ok) throw new Error("Could not check sign-in status");
    const state = await response.json();
    authOptions = state;
    if (state.user) await initApp(state.user);
    else showAuth(state.setup_required ? "setup" : location.pathname === "/register" ? "register" : "login");
  } catch (error) {
    showAuth("login");
    byId("auth-error").textContent = error.message;
  }
}

byId("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!authOptions.local_login_enabled) return;
  const form = event.currentTarget;
  const payload = { username: form.elements.username.value.trim(), password: form.elements.password.value };
  if (authMode !== "login" && payload.password !== form.elements.confirm_password.value) {
    byId("auth-error").textContent = "Passwords do not match";
    return;
  }
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  byId("auth-error").textContent = "";
  try {
    const response = await fetch(authMode === "setup" ? "/auth/setup" : authMode === "register" ? "/auth/register" : "/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "Sign-in failed");
    form.reset();
    if (location.pathname === "/register") history.replaceState(null, "", "/");
    await initApp(result);
  } catch (error) { byId("auth-error").textContent = error.message; }
  finally { button.disabled = false; }
});

byId("sign-out").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  currentUser = null;
  currentProjectId = "";
  sessionStorage.removeItem("bob_workspace_id");
  messages.replaceChildren();
  byId("session-list").replaceChildren();
  byId("page-list").replaceChildren();
  showAuth("login");
});

const userDialog = byId("user-dialog");
byId("add-user").addEventListener("click", () => {
  byId("user-form").reset();
  byId("user-error").textContent = "";
  userDialog.showModal();
});
byId("user-dialog-close").addEventListener("click", () => userDialog.close());
byId("user-dialog-cancel").addEventListener("click", () => userDialog.close());
byId("user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const response = await fetch("/auth/users", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: form.elements.username.value.trim(), password: form.elements.password.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "Could not create user");
    userDialog.close();
  } catch (error) { byId("user-error").textContent = error.message; }
  finally { button.disabled = false; }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendPrompt(promptInput.value).catch(error => reportUiError("Send message", error));
});
promptInput.addEventListener("input", () => {
  resizeInput();
  const value = promptInput.value;
  if (/^\/[a-z0-9-]*$/.test(value) || /^\/(mode|agent)\s+[a-z0-9-]*$/.test(value)) {
    renderSlashMenu(value.slice(1));
  } else {
    slashMenu.classList.add("hidden");
  }
});
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    slashMenu.classList.add("hidden");
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendPrompt(promptInput.value).catch(error => reportUiError("Send message", error));
  }
});
byId("new-chat").addEventListener("click", () => startNewChat().catch(error => reportUiError("Create conversation", error)));
stopButton.addEventListener("click", () => controller?.abort());
byId("mobile-menu").addEventListener("click", () => sidebar.classList.toggle("open"));
byId("slash-button").addEventListener("click", () => {
  if (slashMenu.classList.contains("hidden")) renderSlashMenu();
  else slashMenu.classList.add("hidden");
});
byId("add-skill").addEventListener("click", () => openCreateDialog("skill"));
byId("add-mode").addEventListener("click", () => openCreateDialog("mode"));
byId("add-mcp").addEventListener("click", () => openCreateDialog("mcp"));
byId("add-agent").addEventListener("click", () => openCreateDialog("agent"));
byId("refresh-pages").addEventListener("click", () => loadPages().catch(error => reportUiError("Refresh workspace pages", error)));
byId("preview-close").addEventListener("click", () => previewDialog.close());
byId("preview-refresh").addEventListener("click", () => { if (previewPath) openPreview(previewPath).catch(error => reportUiError("Refresh preview", error)); });
byId("preview-source").addEventListener("click", () => {
  const code = byId("preview-code");
  const frame = byId("preview-frame");
  const showSource = code.classList.contains("hidden");
  code.classList.toggle("hidden", !showSource);
  frame.classList.toggle("hidden", showSource);
  byId("preview-source").textContent = showSource ? "View preview" : "View source";
});
byId("mcp-transport").addEventListener("change", updateMcpFields);
byId("dialog-close").addEventListener("click", () => createDialog.close());
byId("dialog-cancel").addEventListener("click", () => createDialog.close());
byId("agent-edit-close")?.addEventListener("click", () => byId("agent-edit-dialog")?.close());
byId("agent-edit-cancel")?.addEventListener("click", () => byId("agent-edit-dialog")?.close());
byId("agent-edit-form")?.addEventListener("submit", event => saveEditedAgent(event).catch(error => reportUiError("Save agent", error)));
byId("agent-delete-btn")?.addEventListener("click", () => deleteSelectedAgent().catch(error => reportUiError("Delete agent", error)));
byId("change-template-btn")?.addEventListener("click", () => byId("presentation-dialog")?.showModal());
byId("presentation-dialog-close")?.addEventListener("click", () => byId("presentation-dialog")?.close());
createForm.addEventListener("submit", event => saveCreatedItem(event).catch(error => reportUiError("Save item", error)));
for (const button of document.querySelectorAll(".suggestion")) {
  button.addEventListener("click", () => {
    if (button.dataset.prompt) sendPrompt(button.dataset.prompt).catch(error => reportUiError("Send message", error));
    if (button.dataset.fill) {
      promptInput.value = button.dataset.fill;
      resizeInput();
      promptInput.focus();
    }
  });
}

checkAuth().catch(error => reportUiError("Initialize sign-in", error));
