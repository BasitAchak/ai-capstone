const form = document.getElementById("settings-form");
const statusElement = document.getElementById("status");
const resetButton = document.getElementById("reset-button");
const requiredFields = ["projectName", "developerName"];
const assistantForm = document.getElementById("assistant-form");
const assistantInput = document.getElementById("assistant-input");
const assistantMessagesElement = document.getElementById("assistant-messages");
const assistantThinking = document.getElementById("assistant-thinking");
const assistantSend = document.getElementById("assistant-send");
const assistantStop = document.getElementById("assistant-stop");
const assistantStatus = document.getElementById("assistant-status");
const conversation = [];
let activeRequest = null;

function applyTheme(theme) {
  document.body.classList.toggle("theme-dark", theme === "dark");
}

function showStatus(message, type = "") {
  statusElement.textContent = message;
  statusElement.className = `status ${type}`.trim();
}

function setFieldError(fieldName, message) {
  const field = form.elements[fieldName];
  const errorElement = document.getElementById(`${fieldName}-error`);
  field.setAttribute("aria-invalid", message ? "true" : "false");
  errorElement.textContent = message;
}

function validateForm() {
  const errors = {};
  requiredFields.forEach((fieldName) => {
    if (!form.elements[fieldName].value.trim()) {
      errors[fieldName] = `${fieldName === "projectName" ? "Project" : "Developer"} name is required.`;
    }
    setFieldError(fieldName, errors[fieldName] || "");
  });
  return errors;
}

function fillForm(settings) {
  form.elements.projectName.value = settings.projectName;
  form.elements.developerName.value = settings.developerName;
  form.elements.theme.value = settings.theme;
  form.elements.notificationsEnabled.checked = settings.notificationsEnabled;
  requiredFields.forEach((fieldName) => setFieldError(fieldName, ""));
  applyTheme(settings.theme);
}

async function loadSettings(message) {
  const response = await fetch("/api/settings");
  if (!response.ok) throw new Error("Unable to load settings.");
  fillForm(await response.json());
  if (message) showStatus(message, "success");
}

form.elements.theme.addEventListener("change", (event) => applyTheme(event.target.value));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (Object.keys(validateForm()).length > 0) {
    showStatus("Please fix the highlighted fields.", "error");
    return;
  }

  showStatus("Saving...");
  const payload = {
    projectName: form.elements.projectName.value,
    developerName: form.elements.developerName.value,
    theme: form.elements.theme.value,
    notificationsEnabled: form.elements.notificationsEnabled.checked,
  };

  try {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error("Unable to save settings.");
    fillForm(result);
    showStatus("Settings saved successfully.", "success");
  } catch (error) {
    showStatus(error.message, "error");
  }
});

resetButton.addEventListener("click", () => {
  loadSettings("Unsaved changes were reset to the last saved settings.").catch((error) => {
    showStatus(error.message, "error");
  });
});

function addAssistantMessage(role, text = "") {
  const messageElement = document.createElement("article");
  messageElement.className = `assistant-message ${role}`;
  messageElement.textContent = text;
  assistantMessagesElement.appendChild(messageElement);
  return messageElement;
}

function setAssistantStreaming(isStreaming) {
  assistantInput.disabled = isStreaming;
  assistantSend.disabled = isStreaming;
  assistantStop.disabled = !isStreaming;
  assistantThinking.hidden = !isStreaming;
}

function scrollAssistantIfNearBottom() {
  const distanceFromBottom = assistantMessagesElement.scrollHeight - assistantMessagesElement.scrollTop - assistantMessagesElement.clientHeight;
  if (distanceFromBottom < 80) assistantMessagesElement.scrollTop = assistantMessagesElement.scrollHeight;
}

assistantForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = assistantInput.value.trim();
  if (!message || activeRequest) return;

  const userMessage = { role: "user", content: message };
  conversation.push(userMessage);
  addAssistantMessage("user", message);
  const assistantElement = addAssistantMessage("assistant");
  assistantInput.value = "";
  assistantStatus.textContent = "";
  setAssistantStreaming(true);
  activeRequest = new AbortController();
  let receivedText = "";

  try {
    const response = await fetch("/api/assistant/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, messages: conversation.slice(0, -1) }),
      signal: activeRequest.signal,
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || "Unable to contact the assistant.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      receivedText += decoder.decode(value, { stream: true });
      assistantThinking.hidden = true;
      assistantElement.textContent = receivedText;
      scrollAssistantIfNearBottom();
    }
    receivedText += decoder.decode();
    assistantElement.textContent = receivedText;
    conversation.push({ role: "assistant", content: receivedText });
  } catch (error) {
    if (error.name === "AbortError") {
      assistantStatus.textContent = "Response stopped. The partial response was kept.";
      if (receivedText) conversation.push({ role: "assistant", content: receivedText });
    } else {
      assistantStatus.textContent = error.message;
      assistantStatus.className = "status error";
      assistantElement.remove();
      conversation.pop();
    }
  } finally {
    activeRequest = null;
    setAssistantStreaming(false);
    assistantInput.focus();
  }
});

assistantStop.addEventListener("click", () => {
  if (activeRequest) activeRequest.abort();
});

loadSettings().catch((error) => showStatus(error.message, "error"));
