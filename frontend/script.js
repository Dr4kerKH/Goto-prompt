const API_URL = 'http://localhost:8000';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  isFirstMessage: true,
  pendingMessage: '',
  lastGeneratedPrompt: '',
  isStreaming: false,
  isListening: false,
  recognizer: null,
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const chatMessages   = document.getElementById('chat-messages');
const chatMain       = document.getElementById('chat-main');
const textarea       = document.getElementById('message-input');
const sendBtn        = document.getElementById('send-btn');
const micBtn         = document.getElementById('mic-btn');
const refreshBtn     = document.getElementById('refresh-btn');
const modal          = document.getElementById('refinement-modal');
const modalClose     = document.getElementById('modal-close');
const modalSkip      = document.getElementById('modal-skip');
const customContainer = document.getElementById('custom-input-container');
const customInput    = document.getElementById('custom-focus-input');
const customSubmit   = document.getElementById('custom-focus-submit');

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupTextarea();
  setupModal();

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

  if (state.isFirstMessage) {
    state.isFirstMessage = false;
    state.pendingMessage = text;
    showModal();
  } else {
    submitToBackend(text, 'none', null, state.lastGeneratedPrompt || null);
  }
}

function handleModalChoice(focus, customFocus = null) {
  closeModal();
  submitToBackend(state.pendingMessage, focus, customFocus, null);
}

// ── Backend SSE streaming ────────────────────────────────────────────────────
async function submitToBackend(userMessage, focus, customFocus, conversationContext) {
  state.isStreaming = true;
  sendBtn.disabled = true;
  sendBtn.classList.add('opacity-50');

  const messageEl = appendAiMessage();

  try {
    const res = await fetch(`${API_URL}/api/generate-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_message: userMessage,
        focus,
        custom_focus: customFocus,
        conversation_context: conversationContext || null,
      }),
    });

    if (!res.ok) {
      let detail = 'Request failed';
      try { detail = (await res.json()).detail; } catch (_) {}
      finalizeAiMessage(messageEl, null, `Error: ${detail}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';

    // Remove the "thinking" indicator once stream starts
    const thinkingEl = messageEl.querySelector('.thinking-indicator');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const token = line.slice(6);

        if (token.startsWith('[ERROR]')) {
          finalizeAiMessage(messageEl, null, token.slice(7).trim());
          return;
        }

        if (thinkingEl) thinkingEl.remove();

        accumulated += token;
        const codeEl = messageEl.querySelector('.prompt-content');
        if (codeEl) {
          codeEl.textContent = accumulated;
          codeEl.classList.add('streaming-cursor');
        }
        scrollToBottom();
      }
    }

    state.lastGeneratedPrompt = accumulated;
    finalizeAiMessage(messageEl, accumulated, null);

  } catch (err) {
    finalizeAiMessage(messageEl, null, `Network error: ${err.message}`);
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
          Generating prompt…
        </p>
        <div class="bg-surface-container-lowest/80 rounded-lg p-md border border-outline-variant font-code text-code text-on-surface-variant overflow-x-auto">
          <pre><code class="prompt-content whitespace-pre-wrap"></code></pre>
        </div>
        <div class="message-actions flex flex-wrap gap-sm hidden"></div>
      </div>
    </div>`;
  chatMessages.appendChild(div);
  scrollToBottom();
  return div;
}

function finalizeAiMessage(messageEl, content, errorText) {
  const codeEl = messageEl.querySelector('.prompt-content');
  const actionsEl = messageEl.querySelector('.message-actions');
  const thinkingEl = messageEl.querySelector('.thinking-indicator');

  if (thinkingEl) thinkingEl.remove();
  if (codeEl) codeEl.classList.remove('streaming-cursor');

  if (errorText) {
    const codeBlock = messageEl.querySelector('.bg-surface-container-lowest\\/80');
    if (codeBlock) codeBlock.remove();
    const inner = messageEl.querySelector('.flex.flex-col.gap-md');
    if (inner) {
      const errEl = document.createElement('p');
      errEl.className = 'text-error text-sm';
      errEl.textContent = errorText;
      inner.appendChild(errEl);
    }
    return;
  }

  if (actionsEl) {
    actionsEl.classList.remove('hidden');
    actionsEl.innerHTML = `
      <button onclick="injectFollowUp('Make it more detailed and comprehensive')" class="px-md py-sm rounded-full bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors font-label-sm text-label-sm flex items-center gap-xs">
        <span class="material-symbols-outlined text-[16px]">add</span>More detail
      </button>
      <button onclick="injectFollowUp('Make the tone stricter and more authoritative')" class="px-md py-sm rounded-full bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors font-label-sm text-label-sm flex items-center gap-xs">
        <span class="material-symbols-outlined text-[16px]">tune</span>Stricter tone
      </button>
      <button onclick="injectFollowUp('Add concrete examples and edge case guidance')" class="px-md py-sm rounded-full bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors font-label-sm text-label-sm flex items-center gap-xs">
        <span class="material-symbols-outlined text-[16px]">lightbulb</span>Add examples
      </button>
      <button onclick="copyPrompt(this)" data-content="${escapeAttr(content)}" class="px-md py-sm rounded-full glass-panel text-on-surface-variant hover:text-on-surface transition-colors font-label-sm text-label-sm flex items-center gap-xs">
        <span class="material-symbols-outlined text-[16px]">content_copy</span>Copy Prompt
      </button>`;
  }
  scrollToBottom();
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

// ── Modal ─────────────────────────────────────────────────────────────────────
function setupModal() {
  // Focus option buttons (security / performance / best_practices)
  document.querySelectorAll('.focus-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const focus = btn.dataset.focus;
      if (focus === 'custom') {
        customContainer.classList.toggle('hidden');
        customInput.focus();
      } else {
        handleModalChoice(focus);
      }
    });
  });

  customSubmit.addEventListener('click', () => {
    const val = customInput.value.trim();
    if (val) handleModalChoice('custom', val);
  });

  customInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); customSubmit.click(); }
  });

  modalClose.addEventListener('click', () => {
    closeModal();
    submitToBackend(state.pendingMessage, 'none', null, null);
  });

  modalSkip.addEventListener('click', () => {
    closeModal();
    submitToBackend(state.pendingMessage, 'none', null, null);
  });

  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
      submitToBackend(state.pendingMessage, 'none', null, null);
    }
  });
}

function showModal() {
  customContainer.classList.add('hidden');
  customInput.value = '';
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeModal() {
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

// ── Refresh session ───────────────────────────────────────────────────────────
function refreshSession() {
  if (state.isStreaming) return;
  state.isFirstMessage = true;
  state.pendingMessage = '';
  state.lastGeneratedPrompt = '';

  chatMessages.innerHTML = `
    <div id="welcome-section" class="flex flex-col items-center justify-center py-xl gap-md text-center opacity-80 msg-enter">
      <div class="w-16 h-16 rounded-full glass-panel flex items-center justify-center shadow-[0_0_30px_rgba(78,222,163,0.15)]">
        <span class="material-symbols-outlined text-[32px] text-primary" style="font-variation-settings:'FILL' 1">auto_awesome</span>
      </div>
      <h1 class="font-h2 text-h2 text-on-background mt-sm">Luminous Intelligence</h1>
      <p class="font-body-lg text-body-lg text-on-surface-variant max-w-md">Your expert prompt engineering assistant. Describe your task to begin.</p>
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
function scrollToBottom() {
  chatMain.scrollTo({ top: chatMain.scrollHeight, behavior: 'smooth' });
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
