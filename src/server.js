const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { createAiClient, createAiRequest } = require("./ai");

const DEFAULT_SETTINGS = {
  projectName: "AI Capstone Project",
  developerName: "",
  theme: "light",
  notificationsEnabled: true,
};

function validateRequiredName(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateSettings(input) {
  const errors = {};

  if (!validateRequiredName(input.projectName)) {
    errors.projectName = "Project name is required.";
  }
  if (!validateRequiredName(input.developerName)) {
    errors.developerName = "Developer name is required.";
  }

  return errors;
}

function readSettings(settingsPath) {
  return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
}

function writeSettings(settingsPath, settings) {
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function validateAssistantRequest(body) {
  if (!body || typeof body.message !== "string" || !body.message.trim()) {
    return "A non-empty message is required.";
  }
  if (body.message.length > 4000) return "Message must be 4000 characters or fewer.";
  if (body.messages !== undefined && !Array.isArray(body.messages)) {
    return "Conversation messages must be an array.";
  }
  return null;
}

function normalizeConversation(body) {
  const previousMessages = Array.isArray(body.messages) ? body.messages : [];
  const safeMessages = previousMessages
    .filter((message) => message && ["user", "assistant"].includes(message.role))
    .filter((message) => typeof message.content === "string" && message.content.trim())
    .slice(-18)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 4000) }));
  safeMessages.push({ role: "user", content: body.message.trim() });
  return safeMessages;
}

function createApp(options = {}) {
  const settingsPath = options.settingsPath || path.join(__dirname, "..", "data", "settings.json");
  const publicPath = options.publicPath || path.join(__dirname, "..", "public");
  const app = express();

  let currentSettings = readSettings(settingsPath);

  app.use(express.json());
  app.use(express.static(publicPath));

  app.get("/api/settings", (_request, response) => {
  response.json(currentSettings);
});

  app.put("/api/settings", (request, response) => {
    const errors = validateSettings(request.body || {});

    if (Object.keys(errors).length > 0) {
      return response.status(400).json({ errors });
    }

    const settings = {
      projectName: request.body.projectName.trim(),
      developerName: request.body.developerName.trim(),
      theme: request.body.theme === "dark" ? "dark" : "light",
      notificationsEnabled: request.body.notificationsEnabled === true,
    };

        currentSettings = settings;

    if (process.env.VERCEL !== "1") {
      writeSettings(settingsPath, settings);
    }

    return response.json(settings);
  });

  app.post("/api/assistant/stream", async (request, response) => {
    const validationError = validateAssistantRequest(request.body);
    if (validationError) return response.status(400).json({ error: validationError });

    const aiClient = options.aiClient !== undefined ? options.aiClient : createAiClient();
    if (!aiClient) {
      return response.status(503).json({ error: "The assistant is not configured." });
    }

    const abortController = new AbortController();
    let disconnected = false;
    response.on("close", () => {
      if (!response.writableEnded) {
        disconnected = true;
        abortController.abort();
      }
    });

    try {
      const stream = await aiClient.chat.completions.create(
        createAiRequest(normalizeConversation(request.body)),
        { signal: abortController.signal },
      );

      response.status(200);
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.flushHeaders();

      for await (const chunk of stream) {
        if (disconnected) break;
        const text = chunk.choices[0]?.delta?.content;
        if (text) response.write(text);
      }
    } catch (error) {
      if (!disconnected && !abortController.signal.aborted) {
        if (!response.headersSent) {
          response.status(502).json({ error: "The assistant provider is unavailable." });
        } else {
          response.write("\n\nThe assistant could not complete this response.");
        }
      }
    } finally {
      if (!disconnected) response.end();
    }
  });

  return app;
}

const app = createApp();

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

module.exports = app;

module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
module.exports.createApp = createApp;
module.exports.validateRequiredName = validateRequiredName;
module.exports.validateSettings = validateSettings;
module.exports.validateAssistantRequest = validateAssistantRequest;