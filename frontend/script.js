const API_URL = 'http://localhost:8000';

// ── State ────────────────────────────────────────────────────────────────────
const MAX_RECENT_DELTAS = 6;

const state = {
  /** Last accepted full prompt from assistant (prompt-kind only). */
  canonicalPrompt: null,
  /** Prior user instructions, oldest-first, capped — sent as recent_deltas. */
  recentDeltas: [],
  /** Optional explicit task type sent to backend for template selection. */
  selectedTaskType: null,
  isStreaming: false,
  isListening: false,
  recognizer: null,
};

// ── DOM refs (initialized in DOMContentLoaded to guarantee DOM is ready) ─────
let chatMessages, chatMain, textarea, sendBtn, micBtn, refreshBtn;

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  chatMessages = document.getElementById('chat-messages');
  chatMain     = document.getElementById('chat-main');
  textarea     = document.getElementById('message-input');
  sendBtn      = document.getElementById('send-btn');
  micBtn       = document.getElementById('mic-btn');
  refreshBtn   = document.getElementById('refresh-btn');

  setupTextarea();

  sendBtn.addEventListener('click', handleSend);
  refreshBtn.addEventListener('click', refreshSession);
  micBtn.addEventListener('click', handleMic);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
});

// ── Send / submit flow ────────────────────────────────────────────────────────
function handleSend() {
  const text = textarea.value.trim();
  if (!text || state.isStreaming) return;

  textarea.value = '';
  resetTextareaHeight();
  appendUserMessage(text);
  submitToBackend(text);
}

// ── Backend SSE streaming ────────────────────────────────────────────────────
function wantsFreshSession(text) {
  const t = text.toLowerCase();
  return (
    t.includes('start over') ||
    t.includes('new session') ||
    t.includes('new prompt') ||
    t.includes('from scratch') ||
    t.includes('ignore previous') ||
    t.includes('discard canonical') ||
    t.includes('reset prompt')
  );
}

function inferTaskType(text) {
  const t = text.toLowerCase();
  if (
    ['image', 'logo', 'poster', 'illustration', 'thumbnail', 'midjourney', 'dall-e', 'stable diffusion']
      .some((k) => t.includes(k))
  ) {
    return 'image_generation';
  }
  if (
    ['system design', 'architecture', 'design doc', 'tradeoff', 'component diagram', 'mermaid']
      .some((k) => t.includes(k))
  ) {
    return 'design_with_code';
  }
  if (
    ['code', 'bug', 'refactor', 'function', 'class', 'python', 'javascript', 'typescript', 'test']
      .some((k) => t.includes(k))
  ) {
    return 'coding';
  }
  return 'format_rewrite';
}

async function submitToBackend(userMessage) {
  state.isStreaming = true;
  sendBtn.disabled = true;
  sendBtn.classList.add('opacity-50');

  const messageEl = appendAiMessage();

  try {
    if (wantsFreshSession(userMessage)) {
      state.canonicalPrompt = null;
      state.recentDeltas = [];
      state.selectedTaskType = null;
    }
    const taskType = state.selectedTaskType || inferTaskType(userMessage);
    state.selectedTaskType = taskType;

    const res = await fetch(`${API_URL}/api/generate-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_message: userMessage,
        canonical_prompt: state.canonicalPrompt,
        task_type: taskType,
        recent_deltas:
          state.recentDeltas.length > 0 ? [...state.recentDeltas] : null,
      }),
    });

    if (!res.ok) {
      let detail = 'Request failed';
      try { detail = (await res.json()).detail; } catch (_) {}
      finalizeAiMessage(messageEl, null, `Error: ${detail}`, 'prompt');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';
    let responseKind = 'prompt';

    const thinkingEl = messageEl.querySelector('.thinking-indicator');
    const chatProseEl = messageEl.querySelector('.chat-prose');
    const promptBoxEl = messageEl.querySelector('.prompt-box');
    const promptContentEl = messageEl.querySelector('.prompt-content');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const token = line.slice(6);

        if (token.startsWith('[ERROR]')) {
          finalizeAiMessage(messageEl, null, token.slice(7).trim(), 'prompt');
          return;
        }

        if (token.startsWith('[META]')) {
          const k = token.slice(6).trim();
          if (k === 'clarify' || k === 'prompt' || k === 'chat') {
            responseKind = k;
            // Switch to chat prose rendering as soon as [META]chat arrives
            if (k === 'chat' && promptBoxEl && chatProseEl) {
              promptBoxEl.classList.add('hidden');
              chatProseEl.classList.remove('hidden');
            }
          }
          continue;
        }

        if (thinkingEl) thinkingEl.remove();

        accumulated += token;

        if (responseKind === 'chat') {
          if (chatProseEl) {
            chatProseEl.textContent = accumulated;
            chatProseEl.classList.add('streaming-cursor');
          }
        } else {
          if (promptContentEl) {
            promptContentEl.textContent = accumulated;
            promptContentEl.classList.add('streaming-cursor');
          }
        }
        scrollToBottom();
      }
    }

    if (responseKind === 'prompt') {
      state.canonicalPrompt = accumulated.trim() || state.canonicalPrompt;
    }
    if (responseKind === 'chat') {
      state.selectedTaskType = null;
    } else {
      state.recentDeltas.push(userMessage);
      if (state.recentDeltas.length > MAX_RECENT_DELTAS) {
        state.recentDeltas.splice(0, state.recentDeltas.length - MAX_RECENT_DELTAS);
      }
    }

    finalizeAiMessage(messageEl, accumulated, null, responseKind);

  } catch (err) {
    finalizeAiMessage(messageEl, null, `Network error: ${err.message}`, 'prompt');
  } finally {
    state.isStreaming = false;
    sendBtn.disabled = false;
    sendBtn.classList.remove('opacity-50');
  }
}

// ── Message rendering ─────────────────────────────────────────────────────────
function appendUserMessage(content) {
  const div = document.createElement('div');
  div.className = 'flex justify-end w-full msg-enter';
  div.innerHTML = `
    <div class="glass-panel bg-surface-container-high/40 backdrop-blur-md rounded-2xl rounded-tr-sm px-lg py-md max-w-[85%] text-on-surface border border-white/10">
      <p>${escapeHtml(content)}</p>
    </div>`;
  chatMessages.appendChild(div);
  scrollToBottom();
}

function appendAiMessage() {
  const div = document.createElement('div');
  div.className = 'flex justify-start w-full msg-enter';
  div.innerHTML = `
    <div class="flex gap-md w-full">
      <div class="w-8 h-8 shrink-0 rounded-full bg-primary/20 flex items-center justify-center mt-sm">
        <span class="material-symbols-outlined text-[18px] text-primary" style="font-variation-settings:'FILL' 1">psychology</span>
      </div>
      <div class="glass-panel border-l-2 border-l-primary rounded-2xl rounded-tl-sm px-lg py-md w-full max-w-[90%] text-on-surface flex flex-col gap-md">
        <p class="thinking-indicator text-on-surface-variant text-sm flex items-center gap-sm">
          <span class="material-symbols-outlined text-[16px] animate-spin" style="animation-duration:1.5s">progress_activity</span>
          Thinking…
        </p>
        <div class="chat-prose hidden font-body-md text-body-md text-on-surface leading-relaxed whitespace-pre-wrap"></div>
        <div class="prompt-box bg-surface-container-lowest/80 rounded-lg p-md border border-outline-variant overflow-x-auto">
          <div class="prompt-shell">
            <div class="prompt-content font-code text-code text-on-surface-variant whitespace-pre-wrap min-h-[1.25em]"></div>
          </div>
        </div>
        <div class="message-actions flex flex-wrap gap-sm hidden"></div>
      </div>
    </div>`;
  chatMessages.appendChild(div);
  scrollToBottom();
  return div;
}

/** Lines that are only "Section title:" (scannable headings from the model). */
function isSectionHeaderLine(line) {
  const t = line.trim();
  if (t.length < 3 || t.length > 72) return false;
  if (/^\d+\.\s/.test(t)) return false;
  if (/\?\s*$/.test(t)) return false;
  if (!/^[A-Za-z]/.test(t)) return false;
  return /:\s*$/.test(t);
}

function parseSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let pendingHeading = null;
  let bodyLines = [];

  function emit() {
    const body = bodyLines.join('\n');
    bodyLines = [];
    if (pendingHeading === null && !body.trim()) return;
    sections.push({ heading: pendingHeading, body });
  }

  for (const line of lines) {
    if (isSectionHeaderLine(line)) {
      emit();
      pendingHeading = line.trim().replace(/:\s*$/, '');
    } else {
      bodyLines.push(line);
    }
  }
  emit();
  return sections;
}

/** Highlight [YOUR_*], [[BRACKET]], FILL:, and {{ Mustache }}-style placeholders. */
function renderWithPlaceholders(text) {
  const re =
    /\[\[(?:[^\]])+\]\]|\[(?!META\])(?:YOUR_[A-Z0-9_]+|FILL:[^\]\n]+|[A-Z][A-Z0-9_]{3,})\]|\{\{[^}]+\}\}/g;
  let html = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    html += escapeHtml(text.slice(last, m.index));
    html += `<span class="prompt-placeholder">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  html += escapeHtml(text.slice(last));
  return html;
}

function buildFormattedPromptHtml(text, responseKind) {
  if (responseKind === 'clarify') {
    return `<div class="prompt-clarify font-body-md text-on-surface leading-relaxed whitespace-pre-wrap">${renderWithPlaceholders(text)}</div>`;
  }

  const secs = parseSections(text);
  const nonEmpty = secs.filter((s) => s.body.trim().length > 0 || s.heading);
  if (nonEmpty.length === 0) {
    return `<div class="font-code text-code whitespace-pre-wrap text-on-surface-variant leading-relaxed">${renderWithPlaceholders(text)}</div>`;
  }
  if (nonEmpty.length === 1 && !nonEmpty[0].heading) {
    return `<div class="font-code text-code text-on-surface-variant whitespace-pre-wrap leading-relaxed">${renderWithPlaceholders(nonEmpty[0].body)}</div>`;
  }

  return nonEmpty
    .map((s) => {
      const body = renderWithPlaceholders(s.body);
      if (s.heading) {
        return `<section class="prompt-section border-b border-outline-variant/25 pb-md mb-md last:border-b-0 last:mb-0 last:pb-0">
        <h4 class="prompt-section-title font-label-sm text-primary mb-sm">${escapeHtml(s.heading)}</h4>
        <div class="font-code text-code text-on-surface-variant whitespace-pre-wrap leading-relaxed">${body}</div>
      </section>`;
      }
      return `<div class="font-code text-code text-on-surface-variant whitespace-pre-wrap leading-relaxed mb-md">${body}</div>`;
    })
    .join('');
}

function applyPromptFormatting(messageEl, rawText, responseKind) {
  const shell = messageEl.querySelector('.prompt-shell');
  if (!shell || rawText == null) return;
  shell.innerHTML = buildFormattedPromptHtml(rawText, responseKind);
}

function finalizeAiMessage(messageEl, content, errorText, responseKind = 'prompt') {
  const codeEl = messageEl.querySelector('.prompt-content');
  const chatProseEl = messageEl.querySelector('.chat-prose');
  const actionsEl = messageEl.querySelector('.message-actions');
  const thinkingEl = messageEl.querySelector('.thinking-indicator');

  if (thinkingEl) thinkingEl.remove();
  if (codeEl) codeEl.classList.remove('streaming-cursor');
  if (chatProseEl) chatProseEl.classList.remove('streaming-cursor');

  if (errorText) {
    const promptBox = messageEl.querySelector('.prompt-box');
    if (promptBox) promptBox.remove();
    if (chatProseEl) chatProseEl.remove();
    const inner = messageEl.querySelector('.flex.flex-col.gap-md');
    if (inner) {
      const errEl = document.createElement('p');
      errEl.className = 'text-error text-sm';
      errEl.textContent = errorText;
      inner.appendChild(errEl);
    }
    return;
  }

  if (responseKind === 'chat') {
    // Chat response: prose display is already showing; ensure prompt box stays hidden
    const promptBox = messageEl.querySelector('.prompt-box');
    if (promptBox) promptBox.classList.add('hidden');
    if (chatProseEl) {
      chatProseEl.classList.remove('hidden');
      if (content != null && content !== '') chatProseEl.textContent = content;
    }
    // No action buttons for chat responses
    scrollToBottom(true);
    return;
  }

  if (content != null && content !== '') {
    applyPromptFormatting(messageEl, content, responseKind);
  }

  if (actionsEl) {
    actionsEl.classList.remove('hidden');
    actionsEl.innerHTML = `
      <button onclick="injectFollowUp('Make it more detailed and add specific examples')" class="px-md py-sm rounded-full bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors font-label-sm text-label-sm flex items-center gap-xs">
        <span class="material-symbols-outlined text-[16px]">add</span>More detail
      </button>
      <button onclick="injectFollowUp('Make the tone more formal and authoritative')" class="px-md py-sm rounded-full bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors font-label-sm text-label-sm flex items-center gap-xs">
        <span class="material-symbols-outlined text-[16px]">tune</span>Formal tone
      </button>
      <button onclick="injectFollowUp('Make it more concise and to the point')" class="px-md py-sm rounded-full bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors font-label-sm text-label-sm flex items-center gap-xs">
        <span class="material-symbols-outlined text-[16px]">compress</span>More concise
      </button>
      <button onclick="injectFollowUp('Add [YOUR_*] placeholders for anything still unknown and a short checklist at the top')" class="px-md py-sm rounded-full bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors font-label-sm text-label-sm flex items-center gap-xs">
        <span class="material-symbols-outlined text-[16px]">edit_note</span>Placeholders
      </button>
      <button onclick="copyPrompt(this)" data-content="${escapeAttr(content)}" class="ml-auto px-md py-sm rounded-full glass-panel text-on-surface-variant hover:text-on-surface transition-colors font-label-sm text-label-sm flex items-center gap-xs">
        <span class="material-symbols-outlined text-[16px]">content_copy</span>Copy Prompt
      </button>`;
  }
  scrollToBottom(true);
}

// ── Follow-up buttons ─────────────────────────────────────────────────────────
function injectFollowUp(text) {
  textarea.value = text;
  textarea.dispatchEvent(new Event('input'));
  textarea.focus();
}

function copyPrompt(btn) {
  const content = btn.dataset.content || '';
  navigator.clipboard.writeText(content).then(() => {
    const icon = btn.querySelector('.material-symbols-outlined');
    const label = btn.childNodes[btn.childNodes.length - 1];
    if (icon) icon.textContent = 'check';
    if (label && label.nodeType === 3) label.textContent = 'Copied!';
    setTimeout(() => {
      if (icon) icon.textContent = 'content_copy';
      if (label && label.nodeType === 3) label.textContent = 'Copy Prompt';
    }, 2000);
  });
}

// ── Refresh session ───────────────────────────────────────────────────────────
function refreshSession() {
  if (state.isStreaming) return;
  state.canonicalPrompt = null;
  state.recentDeltas = [];
  state.selectedTaskType = null;

  chatMessages.innerHTML = `
    <div id="welcome-section" class="flex flex-col items-center justify-center py-xl gap-md text-center opacity-80 msg-enter">
      <div class="w-16 h-16 rounded-full glass-panel flex items-center justify-center shadow-[0_0_30px_rgba(78,222,163,0.15)]">
        <span class="material-symbols-outlined text-[32px] text-primary" style="font-variation-settings:'FILL' 1">auto_awesome</span>
      </div>
      <h1 class="font-h2 text-h2 text-on-background mt-sm">Goto-Prompt</h1>
      <p class="font-body-lg text-body-lg text-on-surface-variant max-w-md">Your prompt engineering assistant. Describe what you need — I'll ask if I need more details.</p>
    </div>`;
}

// ── Textarea auto-resize ──────────────────────────────────────────────────────
function setupTextarea() {
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  });
}

function resetTextareaHeight() {
  textarea.style.height = '64px';
}

// ── Scroll ────────────────────────────────────────────────────────────────────
function scrollToBottom(smooth = false) {
  if (smooth) {
    chatMain.scrollTo({ top: chatMain.scrollHeight, behavior: 'smooth' });
  } else {
    chatMain.scrollTop = chatMain.scrollHeight;
  }
}

// ── Speech-to-text ────────────────────────────────────────────────────────────
function handleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert('Speech recognition is not supported in this browser. Try Chrome or Edge.');
    return;
  }

  if (state.isListening) {
    state.recognizer?.stop();
    return;
  }

  const rec = new SR();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = 'en-US';
  state.recognizer = rec;
  state.isListening = true;

  const micIcon = micBtn.querySelector('.material-symbols-outlined');
  micIcon.textContent = 'mic_off';
  micBtn.classList.add('text-primary');

  rec.onresult = (e) => {
    let transcript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    textarea.value = transcript;
    textarea.dispatchEvent(new Event('input'));
  };

  rec.onend = () => {
    state.isListening = false;
    micIcon.textContent = 'mic';
    micBtn.classList.remove('text-primary');
  };

  rec.onerror = (e) => {
    console.error('Speech recognition error:', e.error);
    rec.stop();
  };

  rec.start();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '&#10;');
}
