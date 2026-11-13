// Jarvis chat widget. Talks to /api/jarvis (same origin); the API key never reaches the browser.
(function () {
  "use strict";

  const API_URL = "/api/jarvis";
  const STORAGE_KEY = "jarvis:conversation";
  const MAX_HISTORY = 20;
  const MAX_CHARS = 2000;

  let history = loadHistory(); // [{ role, content }]
  let busy = false;
  let config = {
    greeting: "Hi, I'm Jarvis. Ask me anything about this portfolio.",
    suggestions: [],
  };

  // ---------- DOM ----------
  const launcher = h("button", {
    class: "jarvis-launcher",
    type: "button",
    "aria-expanded": "false",
    "aria-controls": "jarvis-panel",
  });
  launcher.innerHTML = '<span class="jarvis-orb" aria-hidden="true"></span><span>Ask Jarvis</span>';

  const panel = h("section", {
    id: "jarvis-panel",
    class: "jarvis-panel",
    role: "dialog",
    "aria-modal": "false",
    "aria-labelledby": "jarvis-title",
    hidden: "",
  });
  panel.innerHTML = `
    <header class="jarvis-header">
      <span class="jarvis-orb" aria-hidden="true"></span>
      <div class="jarvis-heading">
        <h2 id="jarvis-title">Jarvis</h2>
        <p>AI assistant · answers about this portfolio</p>
      </div>
      <button type="button" class="jarvis-icon-btn" data-action="reset" aria-label="Start a new chat" title="New chat">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button type="button" class="jarvis-icon-btn" data-action="close" aria-label="Close Jarvis" title="Close">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </header>
    <div class="jarvis-log" role="log" aria-live="polite" aria-relevant="additions text"></div>
    <div class="jarvis-suggestions" aria-label="Suggested questions"></div>
    <form class="jarvis-form">
      <label class="jarvis-sr-only" for="jarvis-input">Message Jarvis</label>
      <textarea id="jarvis-input" rows="1" maxlength="${MAX_CHARS}" placeholder="Ask about projects, skills…" autocomplete="off"></textarea>
      <button type="submit" class="jarvis-send" aria-label="Send">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5L4 12z" fill="currentColor"/></svg>
      </button>
    </form>
    <p class="jarvis-note">AI-generated answers can be wrong. Don't share personal information.</p>`;

  const log = panel.querySelector(".jarvis-log");
  const suggestionsBox = panel.querySelector(".jarvis-suggestions");
  const form = panel.querySelector(".jarvis-form");
  const input = panel.querySelector("#jarvis-input");
  const sendBtn = panel.querySelector(".jarvis-send");

  document.body.append(launcher, panel);

  // Avoid two "Ask Jarvis" buttons (and covering hero buttons on phones):
  // hide the floating launcher while the page's own [data-jarvis-open] hero trigger is visible.
  const heroTrigger = document.querySelector(".portrait-badge[data-jarvis-open]");
  if (heroTrigger && "IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => launcher.classList.toggle("is-tucked", entry.isIntersecting)).observe(heroTrigger);
  }

  // ---------- helpers ----------
  function h(tag, attrs, text) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
  }

  function loadHistory() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(saved) ? saved.filter((m) => m && typeof m.content === "string") : [];
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-MAX_HISTORY)));
    } catch {
      /* storage unavailable — conversation just won't survive reloads */
    }
  }

  function addBubble(role, text, extraClass) {
    const bubble = h("div", { class: `jarvis-msg jarvis-${role}${extraClass ? " " + extraClass : ""}` }, text);
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  function renderConversation() {
    log.replaceChildren();
    addBubble("assistant", config.greeting);
    history.forEach((m) => addBubble(m.role, m.content));
    renderSuggestions();
  }

  function renderSuggestions() {
    suggestionsBox.replaceChildren();
    if (history.length || !config.suggestions.length) return;
    config.suggestions.forEach((q) => {
      const chip = h("button", { type: "button", class: "jarvis-chip" }, q);
      chip.addEventListener("click", () => send(q));
      suggestionsBox.append(chip);
    });
  }

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
    panel.setAttribute("aria-busy", String(value));
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  }

  // ---------- open / close ----------
  function open() {
    panel.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    launcher.classList.add("is-hidden");
    input.focus();
  }

  function close() {
    panel.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
    launcher.classList.remove("is-hidden");
    launcher.focus();
  }

  // ---------- chat ----------
  async function send(text) {
    text = text.trim();
    if (!text || busy) return;

    history.push({ role: "user", content: text.slice(0, MAX_CHARS) });
    addBubble("user", text);
    suggestionsBox.replaceChildren();
    input.value = "";
    autosize();
    setBusy(true);

    const bubble = addBubble("assistant", "", "is-typing");
    bubble.setAttribute("aria-label", "Jarvis is typing");
    let answer = "";
    let failure = null;

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-MAX_HISTORY) }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Jarvis is unavailable (${res.status}).`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.type === "delta") {
            answer += event.text;
            bubble.classList.remove("is-typing");
            bubble.removeAttribute("aria-label");
            bubble.textContent = answer;
            log.scrollTop = log.scrollHeight;
          } else if (event.type === "error") {
            failure = event.message;
          }
        }
      }
    } catch (err) {
      failure = err.message && !/fetch|network/i.test(err.message) ? err.message : "Couldn't reach Jarvis. Check your connection and try again.";
    }

    bubble.classList.remove("is-typing");
    bubble.removeAttribute("aria-label");
    if (answer) {
      history.push({ role: "assistant", content: answer });
    } else {
      // Nothing came back: drop the unanswered question so the conversation stays valid.
      history.pop();
      bubble.remove();
    }
    if (failure) addBubble("assistant", failure, "is-error");
    saveHistory();
    setBusy(false);
    input.focus();
  }

  // ---------- events ----------
  launcher.addEventListener("click", open);
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-jarvis-open]")) open();
  });
  panel.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "close") close();
    if (action === "reset") {
      history = [];
      saveHistory();
      renderConversation();
      input.focus();
    }
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send(input.value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });
  input.addEventListener("input", autosize);

  // Greeting and suggestions come from the same profile file the portfolio uses.
  renderConversation();
  fetch("/data/profile.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((p) => {
      if (!p?.jarvis) return;
      config = { ...config, ...p.jarvis };
      renderConversation();
    })
    .catch(() => {});
})();
