const form = document.getElementById("assistant-form");
const input = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const messages = document.getElementById("messages");

let conversation = [];

function addMessage(role, text = "") {
  const message = document.createElement("div");
  message.className = `message ${role}`;

  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent = text;

  message.appendChild(content);
  messages.appendChild(message);

  messages.scrollTop = messages.scrollHeight;

  return content;
}

function addToolState(type, data) {
  const wrapper = document.createElement("div");
  wrapper.className = `tool-state ${type}`;

  if (type === "tool-input-streaming") {
    wrapper.innerHTML = `
      <div class="tool-icon">◌</div>
      <div>
        <strong>Calling project tool</strong>
        <span>Preparing the tool request…</span>
      </div>
    `;
  }

  if (type === "tool-input-available") {
    wrapper.innerHTML = `
      <div class="tool-icon">→</div>
      <div>
        <strong>Tool input ready</strong>
        <span>Request prepared for <code>${escapeHtml(data.toolName)}</code></span>
        <div class="tool-input">
          ${formatInput(data.input)}
        </div>
      </div>
    `;
  }

  if (type === "tool-output-available") {
    wrapper.innerHTML = `
      <div class="tool-icon">✓</div>
      <div class="tool-output-content">
        <strong>Project information</strong>
        <span>Tool returned structured data</span>

        <div class="project-card">
          <div class="project-card-title">
            ${escapeHtml(data.output.projectName)}
          </div>

          <div class="project-row">
            <span>Developer</span>
            <strong>${escapeHtml(data.output.developerName)}</strong>
          </div>

          <div class="project-row">
            <span>Theme</span>
            <strong>${escapeHtml(data.output.theme)}</strong>
          </div>

          ${
            data.output.notificationsEnabled !== undefined
              ? `
                <div class="project-row">
                  <span>Notifications</span>
                  <strong>
                    ${
                      data.output.notificationsEnabled
                        ? "Enabled"
                        : "Disabled"
                    }
                  </strong>
                </div>
              `
              : ""
          }
        </div>
      </div>
    `;
  }

  if (type === "tool-error") {
    wrapper.innerHTML = `
      <div class="tool-icon">!</div>
      <div>
        <strong>Tool execution failed</strong>
        <span>${escapeHtml(data.message)}</span>
        <button class="retry-button" type="button">
          Try again
        </button>
      </div>
    `;

    wrapper.querySelector(".retry-button").addEventListener(
      "click",
      () => {
        form.requestSubmit();
      },
    );
  }

  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
}

function formatInput(input) {
  return Object.entries(input || {})
    .map(
      ([key, value]) =>
        `<span>${escapeHtml(key)}: ${escapeHtml(String(value))}</span>`,
    )
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function sendMessage(message) {
  const userMessage = message.trim();

  if (!userMessage) return;

  addMessage("user", userMessage);

  conversation.push({
    role: "user",
    content: userMessage,
  });

  input.value = "";
  sendButton.disabled = true;

  const assistantContent = addMessage("assistant", "");
  let assistantText = "";

  try {
    const response = await fetch("/api/assistant/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: userMessage,
        messages: conversation.slice(-18),
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        error.error || "The assistant request failed.",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, {
        stream: true,
      });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        /*
         * Tool requests use NDJSON.
         */
        if (
          line.startsWith("{") &&
          line.endsWith("}")
        ) {
          try {
            const event = JSON.parse(line);

            if (
              event.type === "tool-input-streaming" ||
              event.type === "tool-input-available" ||
              event.type === "tool-output-available" ||
              event.type === "tool-error"
            ) {
              addToolState(event.type, event);
              continue;
            }

            if (event.type === "text") {
              assistantText += event.text;
              assistantContent.textContent = assistantText;
              continue;
            }

            if (event.type === "error") {
              assistantContent.textContent = event.message;
            }
          } catch {
            assistantText += line;
            assistantContent.textContent = assistantText;
          }
        } else {
          /*
           * Normal assistant requests remain plain-text streams.
           */
          assistantText += line;
          assistantContent.textContent = assistantText;
        }

        messages.scrollTop = messages.scrollHeight;
      }
    }

    if (assistantText.trim()) {
      conversation.push({
        role: "assistant",
        content: assistantText,
      });
    }
  } catch (error) {
    assistantContent.textContent =
      error.message || "Something went wrong.";
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(input.value);
});

document.querySelectorAll(".quick-action").forEach((button) => {
  button.addEventListener("click", () => {
    sendMessage(button.dataset.message);
  });
});