/*
 * Failure-path tests.
 *
 * The happy path is easy to keep working because it is the one anybody
 * exercises by hand. These assert the paths nobody looks at until they fire
 * in front of a user, so that a regression in the error handling is a red
 * build rather than a bad demo.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const request = require("supertest");
const { createApp } = require("../src/server");

const settings = {
  projectName: "Project A",
  developerName: "Developer A",
  theme: "dark",
  notificationsEnabled: false,
};

function makeApp(aiClient) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-capstone-"));
  const settingsPath = path.join(directory, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(settings));

  return createApp({ settingsPath, aiClient });
}

/* A provider that streams `count` tokens, so mid-stream failure is reachable. */
function streamingClient(count = 12) {
  return {
    chat: {
      completions: {
        create() {
          return (async function* () {
            for (let index = 0; index < count; index += 1) {
              yield { choices: [{ delta: { content: `token${index} ` } }] };
            }
          })();
        },
      },
    },
  };
}

function toolClient({ toolArguments = '{"includeNotifications":true}' } = {}) {
  let call = 0;

  return {
    chat: {
      completions: {
        create() {
          call += 1;

          if (call === 1) {
            return Promise.resolve({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "get_project_info",
                          arguments: toolArguments,
                        },
                      },
                    ],
                  },
                },
              ],
            });
          }

          return (async function* () {
            yield { choices: [{ delta: { content: "Here are the settings." } }] };
          })();
        },
      },
    },
  };
}

function parseEvents(text) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function post(app, message, sabotage) {
  const pending = request(app).post("/api/assistant/stream");

  if (sabotage) pending.set("x-sabotage", sabotage);

  return pending.send({ message });
}

test("every streamed line is valid JSON, so a truncated line is never rendered", async () => {
  const app = makeApp(streamingClient(6));
  const response = await post(app, "Tell me about the project.");

  const lines = response.text.trim().split("\n").filter(Boolean);

  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `not valid JSON: ${line}`);
  }
});

test("mid-stream failure keeps the partial text and emits a retryable error", async () => {
  const app = makeApp(streamingClient(20));
  const response = await post(app, "Tell me about the project.", "mid-stream");

  assert.equal(response.status, 200);

  const events = parseEvents(response.text);
  const textEvents = events.filter((event) => event.type === "text");
  const errorEvent = events.find((event) => event.type === "error");

  // Partial content reached the client before the failure.
  assert.ok(textEvents.length > 0, "expected text before the failure");

  // The failure is announced explicitly rather than by silence.
  assert.ok(errorEvent, "expected a terminating error event");
  assert.equal(errorEvent.code, "stream_interrupted");
  assert.equal(errorEvent.retryable, true);

  // The error arrives after the text, never interleaved before it.
  assert.ok(
    events.indexOf(errorEvent) > events.indexOf(textEvents.at(-1)),
    "error must terminate the stream",
  );
});

test("rate limiting fails before the stream opens, as an HTTP 429", async () => {
  const app = makeApp(streamingClient());
  const response = await post(app, "Hello", "rate-limit");

  assert.equal(response.status, 429);
  assert.equal(response.body.code, "rate_limited");
  assert.equal(response.body.retryable, true);
  assert.match(response.body.error, /rate-limited/i);
});

test("provider failure returns 502 with a retryable flag", async () => {
  const app = makeApp(streamingClient());
  const response = await post(app, "Hello", "provider-down");

  assert.equal(response.status, 502);
  assert.equal(response.body.code, "provider_unavailable");
  assert.equal(response.body.retryable, true);
});

test("an empty provider response is reported, not rendered as silence", async () => {
  const app = makeApp(streamingClient(4));
  const response = await post(app, "Hello", "empty");

  const events = parseEvents(response.text);
  const errorEvent = events.find((event) => event.type === "error");

  assert.ok(errorEvent, "an empty response must produce an error event");
  assert.equal(errorEvent.code, "empty_response");
});

test("malformed tool arguments produce a designed tool error, not a crash", async () => {
  const app = makeApp(toolClient());
  const response = await post(app, "Show me the current settings.", "malformed-tool");

  assert.equal(response.status, 200);

  const events = parseEvents(response.text);
  const toolError = events.find((event) => event.type === "tool-error");

  assert.ok(toolError, "expected a tool-error event");
  assert.equal(toolError.code, "tool_invalid_input");
  assert.equal(toolError.retryable, true);
});

test("tool execution failure is reported through the tool error state", async () => {
  const app = makeApp(toolClient());
  const response = await post(app, "Show me the current settings.", "tool-failure");

  const events = parseEvents(response.text);
  const toolError = events.find((event) => event.type === "tool-error");

  assert.ok(toolError);
  assert.equal(toolError.code, "tool_execution_failed");
});

test("the tool happy path walks all four lifecycle states in order", async () => {
  const app = makeApp(toolClient());
  const response = await post(app, "Show me the current settings.");

  const types = parseEvents(response.text).map((event) => event.type);

  assert.ok(
    types.indexOf("tool-input-streaming") <
      types.indexOf("tool-input-available"),
    "input streaming must precede input available",
  );

  assert.ok(
    types.indexOf("tool-input-available") <
      types.indexOf("tool-output-available"),
    "input available must precede output available",
  );

  assert.ok(types.includes("text"), "the model should summarise the result");
  assert.equal(types.at(-1), "done");
});

test("a tool call the provider never makes falls back to text, not an error", async () => {
  const noToolClient = {
    chat: {
      completions: {
        create() {
          return Promise.resolve({
            choices: [
              { message: { role: "assistant", content: "I do not need the tool." } },
            ],
          });
        },
      },
    },
  };

  const app = makeApp(noToolClient);
  const response = await post(app, "Show me the current settings.");

  const events = parseEvents(response.text);

  assert.ok(events.some((event) => event.type === "text"));
  assert.ok(!events.some((event) => event.type === "error"));
});

test("sabotage can be disabled for production", async () => {
  process.env.SABOTAGE_DISABLED = "1";

  try {
    const app = makeApp(streamingClient(8));
    const response = await post(app, "Hello", "rate-limit");

    // The sabotage header is ignored, so the normal flow runs.
    assert.equal(response.status, 200);
    assert.ok(parseEvents(response.text).some((event) => event.type === "text"));
  } finally {
    delete process.env.SABOTAGE_DISABLED;
  }
});

test("oversized input is rejected before reaching the provider", async () => {
  let called = false;

  const app = makeApp({
    chat: {
      completions: {
        create() {
          called = true;
          return (async function* () {})();
        },
      },
    },
  });

  const response = await post(app, "x".repeat(4001));

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "invalid_request");
  assert.equal(called, false, "the provider must not be called");
});
