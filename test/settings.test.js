const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const request = require("supertest");
const { createApp, validateSettings } = require("../src/server");

function makeApp(initialSettings) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-capstone-"));
  const settingsPath = path.join(directory, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(initialSettings));
  return { app: createApp({ settingsPath }), settingsPath };
}

const validSettings = {
  projectName: "Project A",
  developerName: "Developer A",
  theme: "dark",
  notificationsEnabled: false,
};

test("both required names reject empty and whitespace-only values", () => {
  for (const value of ["", " ", "\t", "\n", " \t\n "]) {
    const errors = validateSettings({ projectName: value, developerName: value });
    assert.equal(errors.projectName, "Project name is required.");
    assert.equal(errors.developerName, "Developer name is required.");
  }
});

test("both required names accept non-whitespace values", () => {
  assert.deepEqual(validateSettings(validSettings), {});
});

test("settings form exposes labels and associated validation messages", async () => {
  const { app } = makeApp(validSettings);
  const response = await request(app).get("/settings.html");

  assert.equal(response.status, 200);
  assert.match(response.text, /label for="projectName"/);
  assert.match(response.text, /label for="developerName"/);
  assert.match(response.text, /aria-describedby="projectName-error"/);
  assert.match(response.text, /aria-describedby="developerName-error"/);
  assert.match(response.text, /role="alert"/);
});

test("invalid settings are rejected and do not overwrite saved settings", async () => {
  const { app, settingsPath } = makeApp(validSettings);
  const response = await request(app).put("/api/settings").send({
    projectName: "\t",
    developerName: "",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath)), validSettings);
  assert.equal(response.body.errors.projectName, "Project name is required.");
  assert.equal(response.body.errors.developerName, "Developer name is required.");
});

test("valid settings save successfully and can be saved repeatedly", async () => {
  const { app } = makeApp(validSettings);
  const first = await request(app).put("/api/settings").send(validSettings);
  const secondSettings = { ...validSettings, projectName: "Project B", developerName: "Developer B" };
  const second = await request(app).put("/api/settings").send(secondSettings);

  assert.equal(first.status, 200);
  assert.deepEqual(first.body, validSettings);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, secondSettings);
  const latest = await request(app).get("/api/settings");
  assert.deepEqual(latest.body, secondSettings);
});

test("reading settings returns the most recently saved values for reset", async () => {
  const { app } = makeApp(validSettings);
  const saved = { ...validSettings, projectName: "Saved Project", developerName: "Saved Developer" };
  await request(app).put("/api/settings").send(saved);

  const resetSource = await request(app).get("/api/settings");
  assert.deepEqual(resetSource.body, saved);
  assert.notDeepEqual(resetSource.body, { projectName: "Unsaved Project", developerName: "Unsaved Developer" });
});

test("assistant rejects invalid requests before contacting Groq", async () => {
  const { app } = makeApp(validSettings);
  const response = await request(app).post("/api/assistant/stream").send({ message: " " });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "A non-empty message is required.");
});

test("assistant reports missing configuration without an API key", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-capstone-"));
  const settingsPath = path.join(directory, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(validSettings));
  const app = require("../src/server").createApp({ settingsPath, aiClient: null });
  const response = await request(app).post("/api/assistant/stream").send({ message: "What theme is available?" });

  assert.equal(response.status, 503);
  assert.equal(response.body.error, "The assistant is not configured.");
});

test("assistant forwards Groq text deltas as a real stream", async () => {
  const chunks = [
    { choices: [{ delta: { content: "Use " } }] },
    { choices: [{ delta: { content: "light theme." } }] },
  ];
  const calls = [];
  const aiClient = {
    chat: {
      completions: {
        create(requestOptions) {
          calls.push(requestOptions);
          return (async function* () {
            for (const chunk of chunks) yield chunk;
          })();
        },
      },
    },
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-capstone-"));
  const settingsPath = path.join(directory, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(validSettings));
  const streamedApp = require("../src/server").createApp({
    settingsPath,
    aiClient,
  });
  const response = await request(streamedApp).post("/api/assistant/stream").send({ message: "What theme is available?" });

  assert.equal(response.status, 200);
  assert.equal(response.text, "Use light theme.");
  assert.equal(calls[0].messages.at(-1).content, "What theme is available?");
  assert.equal(calls[0].stream, true);
});

test("assistant returns a provider error before starting the response stream", async () => {
  const aiClient = {
    chat: {
      completions: {
        async create() {
          throw new Error("provider failure");
        },
      },
    },
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-capstone-"));
  const settingsPath = path.join(directory, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(validSettings));
  const app = require("../src/server").createApp({ settingsPath, aiClient });
  const response = await request(app).post("/api/assistant/stream").send({ message: "What theme is available?" });

  assert.equal(response.status, 502);
  assert.equal(response.body.error, "The assistant provider is unavailable.");
});
