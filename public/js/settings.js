const form = document.getElementById("settings-form");
const statusEl = document.getElementById("status");
const resetButton = document.getElementById("reset-button");

function applyTheme(theme) {
  document.body.classList.toggle("theme-dark", theme === "dark");
}

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

async function loadSettings() {
  const response = await fetch("/api/settings");
  if (!response.ok) {
    throw new Error("Failed to load settings.");
  }

  const settings = await response.json();
  form.projectName.value = settings.projectName;
  form.developerName.value = settings.developerName;
  form.theme.value = settings.theme;
  form.notificationsEnabled.checked = settings.notificationsEnabled;
  applyTheme(settings.theme);
}

form.theme.addEventListener("change", (event) => {
  applyTheme(event.target.value);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showStatus("Saving...", "");

  const payload = {
    projectName: form.projectName.value,
    developerName: form.developerName.value,
    theme: form.theme.value,
    notificationsEnabled: form.notificationsEnabled.checked,
  };

  try {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to save settings.");
    }

    showStatus("Settings saved.", "success");
  } catch (error) {
    showStatus(error.message, "error");
  }
});

resetButton.addEventListener("click", async () => {
  try {
    await loadSettings();
    showStatus("Settings reset to last saved values.", "success");
  } catch (error) {
    showStatus(error.message, "error");
  }
});

loadSettings().catch((error) => {
  showStatus(error.message, "error");
});
