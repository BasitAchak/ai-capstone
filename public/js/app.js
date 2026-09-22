/*
 * Project Assistant client.
 *
 * Every state the user can land in is designed here: first run, pending,
 * streaming, stopped, offline, and five distinct failure shapes. The guiding
 * rule is that partial work is never thrown away — if three sentences arrived
 * before the stream died, the user keeps those three sentences.
 */

const form = document.getElementById("assistant-form");
const input = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const stopButton = document.getElementById("stop-button");
const messages = document.getElementById("messages");
const connectionBanner = document.getElementById("connection-banner");
const appError = document.getElementById("app-error");
const sabotageSelect = document.getElementById("sabotage-mode");

/* Wait this long for the first token before calling it a hang. */
const FIRST_TOKEN_TIMEOUT_MS = 25000;

/* Treat the user as "reading history" once they scroll this far up. */
const SCROLL_ANCHOR_THRESHOLD_PX = 64;

let conversation = [];
let isSending = false;
let activeController = null;
let pinnedToBottom = true;

/* ------------------------------------------------------------------ *
 * Application-level error boundary
 *
 * The vanilla equivalent of a route error boundary. If a scripting bug
 * escapes the send path, the user gets a recoverable banner instead of a
 * silently dead input box.
 * ------------------------------------------------------------------ */

function showAppError(detail) {
  if (!appError || appError.hidden === false) return;

  appError.hidden = false;
  appError.querySelector(".app-error-detail").textContent =
    detail || "An unexpected error occurred.";
}

window.addEventListener("error", (event) => {
  showAppError(event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  showAppError(event.reason?.message || String(event.reason || ""));
});

document.getElementById("app-error-reload")?.addEventListener("click", () => {
  window.location.reload();
});

/* ------------------------------------------------------------------ *
 * Connection awareness
 * ------------------------------------------------------------------ */

function updateConnectionBanner() {
  const offline = !navigator.onLine;

  connectionBanner.hidden = !offline;
  document.body.classList.toggle("is-offline", offline);
  syncControls();
}

window.addEventListener("online", updateConnectionBanner);
window.addEventListener("offline", updateConnectionBanner);

/* ------------------------------------------------------------------ *
 * Scrolling
 *
 * Auto-scroll only when the user is already at the bottom. Forcing scroll on
 * every token yanks the view away from someone reading earlier output, and on
 * iOS it fights rubber-band scrolling into a stutter.
 * ------------------------------------------------------------------ */

function isNearBottom() {
  const distance =
    messages.scrollHeight - messages.scrollTop - messages.clientHeight;

  return distance <= SCROLL_ANCHOR_THRESHOLD_PX;
}

messages.addEventListener(
  "scroll",
  () => {
    pinnedToBottom = isNearBottom();
  },
  { passive: true },
);

function maybeScrollToBottom(force = false) {
  if (!force && !pinnedToBottom) return;

  messages.scrollTop = messages.scrollHeight;
  pinnedToBottom = true;
}

/* ------------------------------------------------------------------ *
 * Buttons with a brain
 *
 * Send and Stop are one control in two states. Exactly one is ever visible,
 * so the button always describes what pressing it will do right now.
 * ------------------------------------------------------------------ */

function syncControls() {
  const offline = !navigator.onLine;
  const hasText = input.value.trim().length > 0;

  sendButton.hidden = isSending;
  stopButton.hidden = !isSending;

  sendButton.disabled = offline || !hasText;
  input.disabled = false;

  sendButton.textContent = offline ? "Offline" : "Send";
}

input.addEventListener("input", syncControls);

stopButton.addEventListener("click", () => {
  if (!activeController) return;

  activeController.abort(new DOMException("stopped", "AbortError"));
});

/* ------------------------------------------------------------------ *
 * Rendering helpers
 * ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showEmptyState() {
  if (messages.querySelector(".empty-state")) return;

  const emptyState = document.createElement("div");
  emptyState.className = "empty-state";
  emptyState.innerHTML = `
    <div class="empty-state-icon" aria-hidden="true">✦</div>
    <h2>Ask about this project</h2>
    <p>
      The assistant can read the live project settings and explain how the
      app is configured. Pick a starting point — it drops into the box, so
      you can edit before sending.
    </p>
    <div class="empty-examples">
      <button type="button" class="empty-example" data-message="What can you tell me about this project?">
        Tell me about this project
      </button>
      <button type="button" class="empty-example" data-message="Show me the current project settings.">
        Show project settings
      </button>
      <button type="button" class="empty-example" data-message="What should I improve in this project?">
        Suggest an improvement
      </button>
    </div>
  `;

  messages.appendChild(emptyState);

  /*
   * Click-to-fill, not click-to-send. The example becomes an editable
   * starting point rather than a decision the user already made.
   */
  emptyState.querySelectorAll(".empty-example").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.message;
      syncControls();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  });
}

function removeEmptyState() {
  messages.querySelector(".empty-state")?.remove();
}

function addUserMessage(text) {
  removeEmptyState();

  const wrapper = document.createElement("div");
  wrapper.className = "message user";

  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent = text;

  wrapper.appendChild(content);
  messages.appendChild(wrapper);
  maybeScrollToBottom(true);
}

/*
 * One assistant bubble per turn, created up front holding the skeleton.
 * Content replaces the skeleton inside the same element, so nothing below it
 * ever jumps: the skeleton's three lines are sized to occupy exactly three
 * lines of body text.
 */
function createAssistantTurn() {
  removeEmptyState();

  const wrapper = document.createElement("div");
  wrapper.className = "message assistant is-pending";

  wrapper.innerHTML = `
    <div class="message-content">
      <div class="skeleton" aria-hidden="true">
        <div class="skeleton-line skeleton-line-short"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line skeleton-line-medium"></div>
      </div>
      <span class="visually-hidden">Assistant is responding</span>
    </div>
  `;

  messages.appendChild(wrapper);
  maybeScrollToBottom(true);

  const content = wrapper.querySelector(".message-content");

  return {
    wrapper,
    content,

    setText(text) {
      if (wrapper.classList.contains("is-pending")) {
        wrapper.classList.remove("is-pending");
        content.textContent = "";
      }

      content.textContent = text;
    },

    clearSkeleton() {
      if (wrapper.classList.contains("is-pending")) {
        wrapper.classList.remove("is-pending");
        content.textContent = "";
      }
    },
  };
}

/*
 * The error block attaches beneath whatever already arrived, inside the same
 * turn. It enters with a calm fade rather than a colour flash.
 */
function attachError(turn, { title, message, retryMessage, kind = "error" }) {
  turn.clearSkeleton();
  turn.wrapper.classList.add(`has-${kind}`);

  turn.wrapper.querySelector(".turn-error")?.remove();

  const block = document.createElement("div");
  block.className = `turn-error turn-error-${kind}`;
  block.setAttribute("role", "status");

  block.innerHTML = `
    <div class="turn-error-heading">
      <span class="turn-error-icon" aria-hidden="true">${
        kind === "stopped" ? "■" : "!"
      }</span>
      <strong>${escapeHtml(title)}</strong>
    </div>
    <p class="turn-error-detail">${escapeHtml(message)}</p>
    <button class="retry-button" type="button">
      <span class="retry-label">Retry this message</span>
    </button>
  `;

  const retryButton = block.querySelector(".retry-button");
  const retryLabel = block.querySelector(".retry-label");

  /*
   * Retry choreography. The button disables itself on the first click and
   * states what is being retried, so a second click during the request is
   * impossible rather than merely ignored.
   */
  let retryUsed = false;

  retryButton.addEventListener("click", () => {
    if (retryUsed || isSending) return;

    retryUsed = true;
    retryButton.disabled = true;
    retryLabel.textContent = "Retrying…";

    sendMessage(retryMessage, { retry: true, replaceTurn: turn.wrapper });
  });

  turn.wrapper.appendChild(block);
  maybeScrollToBottom();
}

function formatInput(value) {
  return Object.entries(value || {})
    .map(
      ([key, entry]) =>
        `<span>${escapeHtml(key)}: ${escapeHtml(String(entry))}</span>`,
    )
    .join("");
}

function renderToolState(type, data, retryMessage) {
  const wrapper = document.createElement("div");
  wrapper.className = `tool-state ${type}`;

  if (type === "tool-input-streaming") {
    wrapper.innerHTML = `
      <div class="tool-icon" aria-hidden="true">◌</div>
      <div>
        <strong>Calling project tool</strong>
        <span>Preparing the tool request…</span>
      </div>
    `;
  }

  if (type === "tool-input-available") {
    wrapper.innerHTML = `
      <div class="tool-icon" aria-hidden="true">→</div>
      <div>
        <strong>Tool input ready</strong>
        <span>Request prepared for <code>${escapeHtml(data.toolName)}</code></span>
        <div class="tool-input">${formatInput(data.input)}</div>
      </div>
    `;
  }

  if (type === "tool-output-available") {
    const output = data.output || {};

    wrapper.innerHTML = `
      <div class="tool-icon" aria-hidden="true">✓</div>
      <div class="tool-output-content">
        <strong>Project information</strong>
        <span>Tool returned structured data</span>
        <div class="project-card">
          <div class="project-card-title">${escapeHtml(output.projectName || "Untitled project")}</div>
          <div class="project-row">
            <span>Developer</span>
            <strong>${escapeHtml(output.developerName || "Not set")}</strong>
          </div>
          <div class="project-row">
            <span>Theme</span>
            <strong>${escapeHtml(output.theme || "Not set")}</strong>
          </div>
          ${
            output.notificationsEnabled !== undefined
              ? `<div class="project-row">
                   <span>Notifications</span>
                   <strong>${output.notificationsEnabled ? "Enabled" : "Disabled"}</strong>
                 </div>`
              : ""
          }
        </div>
      </div>
    `;
  }

  if (type === "tool-error") {
    wrapper.innerHTML = `
      <div class="tool-icon" aria-hidden="true">!</div>
      <div>
        <strong>Tool did not complete</strong>
        <span>${escapeHtml(data.message || "The tool failed to run.")}</span>
        <button class="retry-button" type="button">
          <span class="retry-label">Retry this message</span>
        </button>
      </div>
    `;

    const retryButton = wrapper.querySelector(".retry-button");
    const retryLabel = wrapper.querySelector(".retry-label");
    let retryUsed = false;

    retryButton.addEventListener("click", () => {
      if (retryUsed || isSending) return;

      retryUsed = true;
      retryButton.disabled = true;
      retryLabel.textContent = "Retrying…";

      sendMessage(retryMessage, { retry: true, replaceTurn: wrapper });
    });
  }

  messages.appendChild(wrapper);
  maybeScrollToBottom();

  return wrapper;
}

/* ------------------------------------------------------------------ *
 * The send path
 * ------------------------------------------------------------------ */

async function sendMessage(rawMessage, options = {}) {
  const userMessage = (rawMessage || "").trim();

  if (!userMessage || isSending) return;

  /*
   * Network failure before send. Catching this here means the user gets an
   * explanation instead of a generic fetch rejection several seconds later.
   */
  if (!navigator.onLine) {
    options.replaceTurn?.remove();

    if (!options.retry) {
      addUserMessage(userMessage);
      conversation.push({ role: "user", content: userMessage });
      input.value = "";
    }

    const offlineTurn = createAssistantTurn();

    attachError(offlineTurn, {
      title: "You are offline",
      message:
        "This message was not sent. Reconnect and retry — nothing was lost.",
      retryMessage: userMessage,
      kind: "offline",
    });

    syncControls();
    return;
  }

  const isRetry = options.retry === true;

  if (isRetry) {
    options.replaceTurn?.remove();
  } else {
    addUserMessage(userMessage);
    conversation.push({ role: "user", content: userMessage });
    input.value = "";
  }

  isSending = true;
  syncControls();

  const turn = createAssistantTurn();

  activeController = new AbortController();
  const controller = activeController;

  let assistantText = "";
  let receivedText = false;
  let finished = false;
  let toolFlow = false;

  /*
   * A response that never starts is a hang. Give it a deadline so the
   * skeleton cannot spin indefinitely.
   */
  const firstTokenTimer = setTimeout(() => {
    if (!receivedText && !finished) {
      controller.abort(new DOMException("timeout", "TimeoutError"));
    }
  }, FIRST_TOKEN_TIMEOUT_MS);

  try {
    const headers = { "Content-Type": "application/json" };
    const sabotage = sabotageSelect?.value;

    if (sabotage) headers["x-sabotage"] = sabotage;

    const response = await fetch("/api/assistant/stream", {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        message: userMessage,
        // The server appends the current message itself.
        messages: conversation.slice(-19, -1),
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));

      throw Object.assign(
        new Error(payload.error || "The assistant request failed."),
        {
          handled: true,
          status: response.status,
          code: payload.code,
          retryable: payload.retryable !== false,
        },
      );
    }

    if (!response.body) {
      throw Object.assign(new Error("The assistant returned no response body."), {
        handled: true,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let streamErrored = false;

    /*
     * NDJSON: split on newlines, keep the trailing partial line in the buffer.
     * A truncated line is never parsed, so a connection killed mid-token can
     * never render as garbage text.
     */
    const handleLine = (line) => {
      if (!line.trim()) return;

      let event;

      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === "text") {
        clearTimeout(firstTokenTimer);
        receivedText = true;
        assistantText += event.text;
        turn.setText(assistantText);
        maybeScrollToBottom();
        return;
      }

      if (event.type === "error") {
        streamErrored = true;

        attachError(turn, {
          title: assistantText
            ? "Response was cut off"
            : "The assistant could not respond",
          message: event.message || "Something went wrong mid-response.",
          retryMessage: userMessage,
        });

        return;
      }

      if (event.type === "done") {
        finished = true;
        return;
      }

      if (event.type.startsWith("tool-")) {
        toolFlow = true;

        if (turn.wrapper.isConnected && !assistantText) {
          turn.wrapper.remove();
        }

        renderToolState(event.type, event, userMessage);

        if (event.type === "tool-error") streamErrored = true;
      }
    };

    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) handleLine(line);
    }

    if (buffer.trim()) handleLine(buffer);

    clearTimeout(firstTokenTimer);

    if (streamErrored) return;

    if (assistantText.trim()) {
      conversation.push({ role: "assistant", content: assistantText });
      return;
    }

    if (!toolFlow) {
      /*
       * The stream closed cleanly but produced nothing. Silence is a failure
       * too, and it gets the same designed treatment.
       */
      attachError(turn, {
        title: "No response",
        message:
          "The assistant finished without saying anything. This is usually transient.",
        retryMessage: userMessage,
      });
    } else if (turn.wrapper.isConnected) {
      turn.wrapper.remove();
    }
  } catch (error) {
    clearTimeout(firstTokenTimer);

    /* User pressed Stop. Not a failure — keep the partial text. */
    if (error.name === "AbortError") {
      attachError(turn, {
        title: assistantText ? "You stopped this response" : "Response stopped",
        message: assistantText
          ? "The text above is what arrived before you stopped it."
          : "Nothing was generated before you stopped it.",
        retryMessage: userMessage,
        kind: "stopped",
      });

      return;
    }

    if (error.name === "TimeoutError") {
      attachError(turn, {
        title: "The assistant did not respond",
        message:
          "No response arrived within 25 seconds. The service may be busy.",
        retryMessage: userMessage,
      });

      return;
    }

    /*
     * A TypeError from fetch is a transport failure: DNS, dropped connection,
     * or a stream killed mid-flight. Distinguishing it matters, because the
     * advice is different from a server-side error.
     */
    const isTransport = error instanceof TypeError;

    attachError(turn, {
      title: isTransport
        ? assistantText
          ? "Connection lost mid-response"
          : "Could not reach the assistant"
        : "Something went wrong",
      message: isTransport
        ? "The connection dropped. Check your network — your message is kept below."
        : error.message || "An unexpected error occurred.",
      retryMessage: userMessage,
    });
  } finally {
    clearTimeout(firstTokenTimer);
    activeController = null;
    isSending = false;
    syncControls();

    if (document.activeElement === document.body) input.focus();
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const message = input.value.trim();

  if (!message) {
    // Empty input is not an error state; just put the cursor back.
    input.focus();
    return;
  }

  sendMessage(message);
});

document.querySelectorAll(".quick-action").forEach((button) => {
  button.addEventListener("click", () => {
    sendMessage(button.dataset.message);
  });
});

/*
 * On iOS the on-screen keyboard shrinks the visual viewport without resizing
 * the layout viewport, which floats a bottom-anchored composer behind the
 * keyboard. Tracking visualViewport and exposing the offset as a CSS variable
 * keeps the input where the user can see it.
 */
if (window.visualViewport) {
  const applyViewportOffset = () => {
    const offset = Math.max(
      0,
      window.innerHeight -
        window.visualViewport.height -
        window.visualViewport.offsetTop,
    );

    document.documentElement.style.setProperty(
      "--keyboard-inset",
      `${offset}px`,
    );

    if (pinnedToBottom) maybeScrollToBottom(true);
  };

  window.visualViewport.addEventListener("resize", applyViewportOffset);
  window.visualViewport.addEventListener("scroll", applyViewportOffset);
  applyViewportOffset();
}

updateConnectionBanner();
syncControls();
showEmptyState();
