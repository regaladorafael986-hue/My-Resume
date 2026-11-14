// Jarvis chat widget. Talks to /api/jarvis (same origin); the API key never reaches the browser.
// Voice: replies are read aloud with the browser's speech synthesis, and visitors can ask by
// voice with the browser's speech recognition (Chrome, Edge, Safari). Both are free and need no key.
(function () {
  "use strict";

  const API_URL = "/api/jarvis";
  const STORAGE_KEY = "jarvis:conversation";
  const VOICE_KEY = "jarvis:voice";
  const MAX_HISTORY = 20;
  const MAX_CHARS = 2000;

  let history = loadHistory(); // [{ role, content }]
  let busy = false;
  let greeted = false;
  let config = {
    greeting: "Hi, I'm Jarvis. Ask me anything.",
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
        <p class="jarvis-status" aria-live="polite">Personal AI assistant</p>
      </div>
      <button type="button" class="jarvis-icon-btn" data-action="voice" aria-pressed="true" aria-label="Read replies aloud" title="Voice on" hidden>
        <svg class="icon-on" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <svg class="icon-off" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
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
      <textarea id="jarvis-input" rows="1" maxlength="${MAX_CHARS}" placeholder="Ask me anything…" autocomplete="off"></textarea>
      <button type="button" class="jarvis-mic" aria-label="Ask by voice" aria-pressed="false" title="Speak" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <button type="submit" class="jarvis-send" aria-label="Send">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5L4 12z" fill="currentColor"/></svg>
      </button>
    </form>
    <p class="jarvis-note">AI-generated answers can be wrong. Voice uses your browser's speech features.</p>`;

  const log = panel.querySelector(".jarvis-log");
  const status = panel.querySelector(".jarvis-status");
  let defaultStatus = status.textContent;
  const suggestionsBox = panel.querySelector(".jarvis-suggestions");
  const form = panel.querySelector(".jarvis-form");
  const input = panel.querySelector("#jarvis-input");
  const sendBtn = panel.querySelector(".jarvis-send");
  const micBtn = panel.querySelector(".jarvis-mic");
  const voiceBtn = panel.querySelector('[data-action="voice"]');

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
    micBtn.disabled = value;
    panel.setAttribute("aria-busy", String(value));
  }

  function setStatus(text) {
    status.textContent = text || defaultStatus;
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  }

  // ---------- voice output (speech synthesis) ----------
  const synth = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window ? window.speechSynthesis : null;
  let voiceOn = Boolean(synth) && readVoicePref();
  let voices = [];
  let speechGen = 0; // bumps on stop, so callbacks from cancelled utterances are ignored
  let pendingUtterances = 0;

  // A calm, British "Jarvis" voice when the system has one; otherwise any English voice.
  const PREFERRED_VOICES = [/Google UK English Male/i, /Ryan.*Natural/i, /Thomas.*Natural/i, /Guy.*Natural/i, /Christopher.*Natural/i, /^Daniel/i, /Arthur/i];
  const TAGALOG_WORDS = /\b(ang|ng|mga|sa|ay|ko|mo|po|naman|siya|ito|ako|ikaw|hindi|oo|kung|lang|din|rin|niya|nila|kayo|tayo|natin|yung|ba)\b/gi;

  function readVoicePref() {
    try {
      return localStorage.getItem(VOICE_KEY) !== "off";
    } catch {
      return true;
    }
  }

  function saveVoicePref() {
    try {
      localStorage.setItem(VOICE_KEY, voiceOn ? "on" : "off");
    } catch {
      /* preference just won't persist */
    }
  }

  function refreshVoices() {
    voices = synth ? synth.getVoices() : [];
  }

  function pickVoice(lang) {
    if (lang === "fil") {
      const fil = voices.find((v) => /^(fil|tl)\b/i.test(v.lang));
      if (fil) return fil;
    }
    for (const re of PREFERRED_VOICES) {
      const v = voices.find((voice) => re.test(voice.name) && /^en/i.test(voice.lang));
      if (v) return v;
    }
    return voices.find((v) => /^en-GB/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang)) || null;
  }

  function cleanForSpeech(text) {
    return text
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[*_`#>|]/g, "")
      .replace(/^\s*[-•]\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function setSpeaking(on) {
    panel.classList.toggle("is-speaking", on);
    launcher.classList.toggle("is-speaking", on);
    if (on) setStatus("Speaking…");
    else if (status.textContent === "Speaking…") setStatus();
  }

  function detectLang(text) {
    return (text.match(TAGALOG_WORDS) || []).length >= 2 ? "fil" : "en";
  }

  // `lang` is decided once per answer, so one reply never switches voices mid-way.
  function speak(text, lang = "en") {
    if (!voiceOn || !synth) return;
    const clean = cleanForSpeech(text);
    if (!clean) return;
    const utterance = new SpeechSynthesisUtterance(clean);
    const voice = pickVoice(lang);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = 1.02;
    utterance.pitch = 0.95;
    const gen = speechGen;
    const done = () => {
      if (gen !== speechGen) return;
      pendingUtterances = Math.max(0, pendingUtterances - 1);
      if (pendingUtterances === 0) setSpeaking(false);
    };
    utterance.onstart = () => gen === speechGen && setSpeaking(true);
    utterance.onend = done;
    utterance.onerror = done;
    pendingUtterances++;
    synth.speak(utterance);
  }

  function stopSpeaking() {
    if (!synth) return;
    speechGen++;
    pendingUtterances = 0;
    synth.cancel();
    setSpeaking(false);
  }

  function renderVoiceToggle() {
    voiceBtn.setAttribute("aria-pressed", String(voiceOn));
    voiceBtn.title = voiceOn ? "Voice on" : "Voice off";
  }

  if (synth) {
    refreshVoices();
    synth.addEventListener?.("voiceschanged", refreshVoices);
    voiceBtn.hidden = false;
    renderVoiceToggle();
    window.addEventListener("pagehide", stopSpeaking);
  }

  // ---------- voice input (speech recognition) ----------
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;

  function setListening(on) {
    micBtn.classList.toggle("is-listening", on);
    micBtn.setAttribute("aria-pressed", String(on));
    micBtn.setAttribute("aria-label", on ? "Stop listening" : "Ask by voice");
    setStatus(on ? "Listening…" : "");
  }

  function startListening() {
    if (busy) return;
    stopSpeaking();
    let finalText = "";
    recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      input.value = (finalText + interim).trim();
      autosize();
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        addBubble("assistant", "Microphone access is blocked. Allow it in your browser settings to talk to Jarvis, or type your question.", "is-error");
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        addBubble("assistant", "I couldn't catch that. Try again, or type your question.", "is-error");
      }
    };
    recognition.onend = () => {
      recognition = null;
      setListening(false);
      if (finalText.trim()) send(finalText);
    };

    try {
      recognition.start();
      setListening(true);
    } catch {
      recognition = null;
      setListening(false);
    }
  }

  function stopListening() {
    recognition?.stop();
  }

  if (Recognition) micBtn.hidden = false;

  // ---------- open / close ----------
  function open() {
    panel.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    launcher.classList.add("is-hidden");
    input.focus();
    // First open of a fresh chat: Jarvis introduces itself (the click counts as a user gesture).
    if (!greeted && history.length === 0) speak(config.greeting);
    greeted = true;
  }

  function close() {
    stopListening();
    stopSpeaking();
    panel.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
    launcher.classList.remove("is-hidden");
    launcher.focus();
  }

  // ---------- chat ----------
  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    stopSpeaking();

    history.push({ role: "user", content: text.slice(0, MAX_CHARS) });
    addBubble("user", text);
    suggestionsBox.replaceChildren();
    input.value = "";
    autosize();
    setBusy(true);
    setStatus("Thinking…");

    const bubble = addBubble("assistant", "", "is-typing");
    bubble.setAttribute("aria-label", "Jarvis is typing");
    let answer = "";
    let spokenUpTo = 0;
    let failure = null;
    const replyLang = detectLang(text); // Jarvis answers in the visitor's language

    // Speak complete sentences as soon as they arrive instead of waiting for the whole answer.
    const speakCompleteSentences = (final) => {
      const rest = answer.slice(spokenUpTo);
      let cut = final ? rest.length : 0;
      if (!final) for (const m of rest.matchAll(/[.!?…]["')\]]?\s+|\n+/g)) cut = m.index + m[0].length;
      if (cut > 0) {
        speak(rest.slice(0, cut), replyLang);
        spokenUpTo += cut;
      }
    };

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
            if (!answer) setStatus();
            answer += event.text;
            bubble.classList.remove("is-typing");
            bubble.removeAttribute("aria-label");
            bubble.textContent = answer;
            log.scrollTop = log.scrollHeight;
            speakCompleteSentences(false);
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
      speakCompleteSentences(true);
      history.push({ role: "assistant", content: answer });
    } else {
      // Nothing came back: drop the unanswered question so the conversation stays valid.
      history.pop();
      bubble.remove();
    }
    if (failure) addBubble("assistant", failure, "is-error");
    if (status.textContent === "Thinking…") setStatus();
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
    if (action === "voice") {
      voiceOn = !voiceOn;
      if (!voiceOn) stopSpeaking();
      saveVoicePref();
      renderVoiceToggle();
    }
    if (action === "reset") {
      stopListening();
      stopSpeaking();
      history = [];
      saveHistory();
      renderConversation();
      input.focus();
    }
  });
  micBtn.addEventListener("click", () => (recognition ? stopListening() : startListening()));
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

  // Jarvis is the site owner's personal assistant: name, greeting and suggestions come from profile.json.
  renderConversation();
  fetch("/data/profile.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((p) => {
      const first = p?.name?.trim().split(/\s+/)[0];
      if (first) {
        defaultStatus = `${first}'s personal AI assistant`;
        if (!busy && !recognition) setStatus();
        input.placeholder = `Ask anything about ${first}…`;
      }
      if (!p?.jarvis) return;
      config = { ...config, ...p.jarvis };
      renderConversation();
    })
    .catch(() => {});
})();
