const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const SETTINGS_PATH = path.join(__dirname, "..", "data", "settings.json");
const PUBLIC_DIR = path.join(__dirname, "..", "public");

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

function readSettings() {
  const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
  return JSON.parse(raw);
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

app.get("/api/settings", (_req, res) => {
  res.json(readSettings());
});

app.put("/api/settings", (req, res) => {
  const current = readSettings();
  const updated = {
    projectName: String(req.body.projectName ?? current.projectName).trim(),
    developerName: String(req.body.developerName ?? current.developerName).trim(),
    theme: req.body.theme === "dark" ? "dark" : "light",
    notificationsEnabled: Boolean(req.body.notificationsEnabled),
  };

  if (!updated.projectName) {
    return res.status(400).json({ error: "Project name is required." });
  }

  writeSettings(updated);
  res.json(updated);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
