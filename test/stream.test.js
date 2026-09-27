/*
 * Failure-path tests.
 *
 * These tests cover the failure states that are easy to miss during manual
 * testing: malformed streams, mid-stream interruption, rate limits,
 * provider failures, empty responses, tool failures, and oversized input.
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

  return createApp({
    settingsPath,
    aiClient,
  });
}

function streamingClient(count = 12) {
  return {
    chat: {
      completions: {
        create() {
          return (async function* () {
            for (let index = 0; index < count; index += 1) {
              yield {
                choices: [
                  {
                    delta: {
                      content: `token${index} `,
                    },
                  },
                ],
              };
            }
          })();
        },
      },
    },
  };
}

function toolClient({
  toolArguments = '{"includeNotifications":true}',
} = {}) {
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
            yield {
              choices: [
                {
                  delta: {
                    content: "Here are the settings.",
                  },
                },
              ],
            };
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

  if (sabotage) {
    pending.set("x-sabotage", sabotage);
  }

  return pending.send({ message });
}

test("every streamed line is valid JSON, so a truncated line is never rendered", async () => {
  const app = makeApp(streamingClient(6));

  const response = await post(
    app,
    "Explain how caching works.",
  );

  const lines = response.text
    .trim()
    .split("\n")
    .filter(Boolean);

  for (const line of lines) {
    assert.doesNotThrow(
      () => JSON.parse(line),
      `not valid JSON: ${line}`,
    );
  }
});

test("mid-stream failure keeps the partial text and emits a retryable error", async () => {
  const app = makeApp(streamingClient(20));

  const response = await post(
    app,
    "Explain how caching works.",
    "mid-stream",
  );

  assert.equal(response.status, 200);

  const events = parseEvents(response.text);

  const textEvents = events.filter(
    (event) => event.type === "text",
  );

  const errorEvent = events.find(
    (event) => event.type === "error",
  );

  assert.ok(
    textEvents.length > 0,
    "expected text before the failure",
  );

  assert.ok(
    errorEvent,
    "expected a terminating error event",
  );

  assert.equal(
    errorEvent.code,
    "stream_interrupted",
  );

  assert.equal(
    errorEvent.retryable,
    true,
  );

  assert.ok(
    events.indexOf(errorEvent) >
      events.indexOf(textEvents.at(-1)),
    "error must terminate the stream",
  );
});

test("rate limiting fails before the stream opens, as an HTTP 429", async () => {
  const app = makeApp(streamingClient());

  const response = await post(
    app,
    "Explain caching.",
    "rate-limit",
  );

  assert.equal(response.status, 429);
  assert.equal(response.body.code, "rate_limited");
  assert.equal(response.body.retryable, true);
});

test("provider failure returns 502 with a retryable flag", async () => {
  const aiClient = {
    chat: {
      completions: {
        create() {
          throw new Error("provider unavailable");
        },
      },
    },
  };

  const app = makeApp(aiClient);

  const response = await post(
    app,
    "Explain caching.",
  );

  assert.equal(response.status, 502);
  assert.equal(response.body.retryable, true);
});

test("an empty provider response is reported, not rendered as silence", async () => {
  const aiClient = {
    chat: {
      completions: {
        create() {
          return (async function* () {})();
        },
      },
    },
  };

  const app = makeApp(aiClient);

  const response = await post(
    app,
    "Explain caching.",
  );

  assert.equal(response.status, 200);

  const events = parseEvents(response.text);

  const errorEvent = events.find(
    (event) => event.type === "error",
  );

  assert.ok(
    errorEvent,
    "expected an empty-response error",
  );

  assert.equal(
    errorEvent.code,
    "empty_response",
  );

  assert.equal(
    errorEvent.retryable,
    true,
  );
});

test("malformed tool arguments produce a designed tool error, not a crash", async () => {
  const app = makeApp(
    toolClient({
      toolArguments: "{not-valid-json}",
    }),
  );

  const response = await post(
    app,
    "Show me the current project settings.",
  );

  assert.equal(response.status, 200);

  const events = parseEvents(response.text);

  const toolError = events.find(
    (event) => event.type === "tool-error",
  );

  assert.ok(
    toolError,
    "expected a tool error event",
  );

  assert.equal(
    toolError.toolName,
    "get_project_info",
  );
});

test("tool execution failure is reported through the tool error state", async () => {
  const app = makeApp(
    toolClient({
      toolArguments: '{"includeNotifications":true}',
    }),
  );

  const response = await post(
    app,
    "Show me the current project settings.",
    "tool-failure",
  );

  assert.equal(response.status, 200);

  const events = parseEvents(response.text);

  const toolError = events.find(
    (event) => event.type === "tool-error",
  );

  assert.ok(
    toolError,
    "expected a tool execution error",
  );
});

test("the tool happy path walks all four lifecycle states in order", async () => {
  const app = makeApp(
    toolClient(),
  );

  const response = await post(
    app,
    "Show me the current project settings.",
  );

  assert.equal(response.status, 200);

  const events = parseEvents(response.text);

  const lifecycle = events
    .map((event) => event.type)
    .filter((type) =>
      [
        "tool-input-streaming",
        "tool-input-available",
        "tool-output-available",
        "text",
      ].includes(type),
    );

  assert.deepEqual(
    lifecycle.slice(0, 4),
    [
      "tool-input-streaming",
      "tool-input-available",
      "tool-output-available",
      "text",
    ],
  );
});

test("a tool call the provider never makes falls back to text, not an error", async () => {
  const aiClient = {
    chat: {
      completions: {
        create() {
          /*
           * runChatFlow() expects the provider response to be an async
           * iterable. Return one streamed text chunk rather than a Promise
           * containing a normal completion object.
           */
          return (async function* () {
            yield {
              choices: [
                {
                  delta: {
                    content:
                      "The assistant did not need the project tool for that question.",
                  },
                },
              ],
            };
          })();
        },
      },
    },
  };

  const app = makeApp(aiClient);

  const response = await post(
    app,
    "Say hello.",
  );

  assert.equal(response.status, 200);

  const events = parseEvents(response.text);

  const textEvent = events.find(
    (event) => event.type === "text",
  );

  assert.ok(
    textEvent,
    "expected fallback text",
  );

  assert.match(
    textEvent.text,
    /did not need the project tool/i,
  );

  assert.equal(
    events.some(
      (event) => event.type === "error",
    ),
    false,
  );
});

test("sabotage can be disabled for production", async () => {
  const previous = process.env.SABOTAGE_DISABLED;

  process.env.SABOTAGE_DISABLED = "1";

  try {
    const app = makeApp(
      streamingClient(6),
    );

    const response = await post(
      app,
      "Explain how caching works.",
      "mid-stream",
    );

    assert.equal(response.status, 200);

    const events = parseEvents(response.text);

    assert.equal(
      events.some(
        (event) =>
          event.type === "error" &&
          event.code === "stream_interrupted",
      ),
      false,
    );

    assert.equal(
      events.some(
        (event) => event.type === "done",
      ),
      true,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.SABOTAGE_DISABLED;
    } else {
      process.env.SABOTAGE_DISABLED = previous;
    }
  }
});

test("oversized input is rejected before reaching the provider", async () => {
  let providerCalled = false;

  const aiClient = {
    chat: {
      completions: {
        create() {
          providerCalled = true;

          return (async function* () {
            yield {
              choices: [
                {
                  delta: {
                    content: "Should not run.",
                  },
                },
              ],
            };
          })();
        },
      },
    },
  };

  const app = makeApp(aiClient);

  const oversizedMessage = "x".repeat(10001);

  const response = await post(
    app,
    oversizedMessage,
  );

  assert.equal(
    providerCalled,
    false,
    "provider should not receive oversized input",
  );

  assert.ok(
    response.status >= 400,
    "expected an HTTP validation error",
  );
});