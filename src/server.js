const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const {
  createAiClient,
  createAiRequest,
  createToolRequest,
} = require("./ai");

const { projectInfoTool } = require("./tools/project-info");

const DEFAULT_SETTINGS = {
  projectName: "AI Capstone Project",
  developerName: "",
  theme: "light",
  notificationsEnabled: true,
};

/*
 * How long we wait for the provider to produce its FIRST token before we
 * give up. A stream that has started is allowed to run; a stream that never
 * starts is a hang, and a hang with no feedback is the worst failure state.
 */
const FIRST_TOKEN_TIMEOUT_MS = 20000;

/*
 * Sabotage modes. These exist so the failure paths are reproducible on the
 * deployed preview URL instead of only on a throttled laptop. A reviewer can
 * trigger any of them from the UI panel, or with a header:
 *
 *   curl -H 'x-sabotage: mid-stream' ...
 *
 * Set SABOTAGE_DISABLED=1 to turn the whole mechanism off.
 */
const SABOTAGE_MODES = new Set([
  "mid-stream",
  "rate-limit",
  "provider-down",
  "malformed-tool",
  "tool-failure",
  "slow",
  "hang",
  "empty",
]);

const SABOTAGE_MID_STREAM_AFTER_CHUNKS = 5;

function resolveSabotage(request) {
  if (process.env.SABOTAGE_DISABLED === "1") return null;

  const mode =
    request.get("x-sabotage") ||
    (typeof request.query.sabotage === "string"
      ? request.query.sabotage
      : null);

  return SABOTAGE_MODES.has(mode) ? mode : null;
}

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
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
}

function validateAssistantRequest(body) {
  if (!body || typeof body.message !== "string" || !body.message.trim()) {
    return "A non-empty message is required.";
  }

  if (body.message.length > 4000) {
    return "Message must be 4000 characters or fewer.";
  }

  if (body.messages !== undefined && !Array.isArray(body.messages)) {
    return "Conversation messages must be an array.";
  }

  return null;
}

function normalizeConversation(body) {
  const previousMessages = Array.isArray(body.messages) ? body.messages : [];

  const safeMessages = previousMessages
    .filter((message) => message && ["user", "assistant"].includes(message.role))
    .filter(
      (message) =>
        typeof message.content === "string" && message.content.trim(),
    )
    .slice(-18)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 4000),
    }));

  safeMessages.push({
    role: "user",
    content: body.message.trim(),
  });

  return safeMessages;
}

/*
 * Every response on this route is newline-delimited JSON, for both the plain
 * chat flow and the tool flow. A single wire format means the client has one
 * parser and one error path.
 *
 * The previous version streamed raw text and marked failures with a
 * "[[AI_STREAM_ERROR]]" sentinel inside the text. That sentinel could be split
 * across two TCP chunks, so the client would miss the error and render half a
 * marker as visible assistant text. NDJSON has no such failure mode: a line is
 * either complete or still buffered.
 */
function sendEvent(response, type, data = {}) {
  if (response.writableEnded) return;
  response.write(`${JSON.stringify({ type, ...data })}\n`);
}

function startStream(response) {
  response.status(200);
  response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("X-Content-Type-Options", "nosniff");
  // Stops proxies (including Vercel's) from buffering the stream into one blob.
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
}

/*
 * Maps a provider exception onto something the user can act on. The client
 * decides how to present it; the server decides what is true about it.
 */
function describeProviderError(error) {
  const status = error?.status || error?.statusCode;

  if (status === 429) {
    return {
      status: 429,
      code: "rate_limited",
      message:
        "The assistant is rate-limited right now. Wait a few seconds and try again.",
      retryable: true,
    };
  }

  if (status === 401 || status === 403) {
    return {
      status: 502,
      code: "auth_failed",
      message: "The assistant could not authenticate with its provider.",
      retryable: false,
    };
  }

  if (error?.name === "TimeoutError" || error?.code === "ETIMEDOUT") {
    return {
      status: 504,
      code: "timeout",
      message: "The assistant took too long to respond. Try again.",
      retryable: true,
    };
  }

  return {
    status: 502,
    code: "provider_unavailable",
    message: "The assistant provider is unavailable.",
    retryable: true,
  };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function createApp(options = {}) {
  const settingsPath =
    options.settingsPath || path.join(__dirname, "..", "data", "settings.json");

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

    if (validationError) {
      return response.status(400).json({
        error: validationError,
        code: "invalid_request",
        retryable: false,
      });
    }

    const sabotage = resolveSabotage(request);

    const aiClient =
      options.aiClient !== undefined ? options.aiClient : createAiClient();

    if (!aiClient) {
      return response.status(503).json({
        error:
          "The assistant is not configured. Add a GROQ_API_KEY and restart the server.",
        code: "not_configured",
        retryable: false,
      });
    }

    /*
     * Pre-stream sabotage. These fail before any headers go out, so they
     * exercise the client's HTTP error path rather than its stream error path.
     */
    if (sabotage === "rate-limit") {
      return response.status(429).json({
        error:
          "The assistant is rate-limited right now. Wait a few seconds and try again.",
        code: "rate_limited",
        retryable: true,
      });
    }

    if (sabotage === "provider-down") {
      return response.status(502).json({
        error: "The assistant provider is unavailable.",
        code: "provider_unavailable",
        retryable: true,
      });
    }

    const messages = normalizeConversation(request.body);

    const abortController = new AbortController();
    let disconnected = false;

    response.on("close", () => {
      if (!response.writableEnded) {
        disconnected = true;
        abortController.abort();
      }
    });

    /*
     * "hang" never sends anything. It is how we test the client's stop button
     * and its own first-token timeout.
     */
    if (sabotage === "hang") {
      startStream(response);
      return;
    }

    const wantsTool =
      sabotage === "malformed-tool" ||
      sabotage === "tool-failure" ||
      /\b(project info|project information|current settings|show.*settings|tool test|tell me about (this|the) project|about this project)\b/i.test(
        request.body.message,
      );

    try {
      if (sabotage === "slow") {
        await delay(6000, abortController.signal);
      }

      if (wantsTool) {
        await runToolFlow({
          response,
          aiClient,
          messages,
          abortController,
          isDisconnected: () => disconnected,
          settings: currentSettings,
          sabotage,
        });
      } else {
        await runChatFlow({
          response,
          aiClient,
          messages,
          abortController,
          isDisconnected: () => disconnected,
          sabotage,
        });
      }
    } catch (error) {
      if (disconnected || abortController.signal.aborted) return;

      // Always log to the terminal — the browser only ever gets a safe,
      // generic message, so this is the only place the real cause is visible.
      console.error("[assistant/stream]", error);

      const described = describeProviderError(error);

      if (!response.headersSent) {
        return response.status(described.status).json({
          error: described.message,
          code: described.code,
          retryable: described.retryable,
        });
      }

      sendEvent(response, "error", {
        message: described.message,
        code: described.code,
        retryable: described.retryable,
      });
    } finally {
      if (!disconnected && !response.writableEnded) {
        if (response.headersSent) sendEvent(response, "done");
        response.end();
      }
    }
  });

  return app;
}

/*
 * PLAIN CHAT FLOW
 */
async function runChatFlow({
  response,
  aiClient,
  messages,
  abortController,
  isDisconnected,
  sabotage,
}) {
  /*
   * The provider call itself gets a deadline. Without this, a provider that
   * accepts the connection and then stalls leaves the user on a skeleton
   * forever.
   */
  const timeout = setTimeout(() => {
    abortController.abort(new Error("first_token_timeout"));
  }, FIRST_TOKEN_TIMEOUT_MS);

  let stream;

  try {
    stream = await aiClient.chat.completions.create(createAiRequest(messages), {
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  startStream(response);

  let chunkCount = 0;
  let sentAnyText = false;

  for await (const chunk of stream) {
    if (isDisconnected()) return;

    const text = chunk.choices?.[0]?.delta?.content;

    if (!text) continue;

    if (sabotage === "empty") continue;

    sendEvent(response, "text", { text });
    sentAnyText = true;
    chunkCount += 1;

    /*
     * Mid-stream sabotage: the hardest case to handle well, because the user
     * already has partial content on screen. We keep what arrived and attach
     * a designed error beneath it rather than throwing the partial away.
     */
    if (
      sabotage === "mid-stream" &&
      chunkCount >= SABOTAGE_MID_STREAM_AFTER_CHUNKS
    ) {
      sendEvent(response, "error", {
        message:
          "The response was cut off before it finished. The text above is incomplete.",
        code: "stream_interrupted",
        retryable: true,
        partial: true,
      });

      return;
    }
  }

  if (!sentAnyText) {
    sendEvent(response, "error", {
      message: "The assistant returned an empty response.",
      code: "empty_response",
      retryable: true,
    });
  }
}

/*
 * TOOL FLOW — four designed states: input streaming, input available,
 * output available, output error.
 */
async function runToolFlow({
  response,
  aiClient,
  messages,
  abortController,
  isDisconnected,
  settings,
  sabotage,
}) {
  startStream(response);

  sendEvent(response, "tool-input-streaming", {
    toolName: projectInfoTool.name,
  });

  let toolResponse;

  try {
    toolResponse = await aiClient.chat.completions.create(
      createToolRequest(messages),
      { signal: abortController.signal },
    );
  } catch (error) {
    if (isDisconnected()) return;

    console.error("[assistant/stream] tool provider call failed", error);

    const described = describeProviderError(error);

    sendEvent(response, "tool-error", {
      toolName: projectInfoTool.name,
      message: described.message,
      code: described.code,
      retryable: described.retryable,
    });

    return;
  }

  if (isDisconnected()) return;

  const toolCall = toolResponse.choices?.[0]?.message?.tool_calls?.[0];

  if (!toolCall) {
    const fallback =
      toolResponse.choices?.[0]?.message?.content ||
      "The assistant did not need the project tool for that question.";

    sendEvent(response, "text", { text: fallback });
    return;
  }

  /*
   * Malformed tool arguments. Real providers do emit invalid JSON here, so it
   * is parsed defensively and reported as a designed state, never thrown.
   */
  const rawArguments =
    sabotage === "malformed-tool"
      ? '{"includeNotifications": tru'
      : toolCall.function?.arguments || "{}";

  let toolInput;

  try {
    toolInput = JSON.parse(rawArguments);
  } catch {
    sendEvent(response, "tool-error", {
      toolName: projectInfoTool.name,
      message:
        "The tool was called with malformed input and could not run. Retrying usually fixes this.",
      code: "tool_invalid_input",
      retryable: true,
    });

    return;
  }

  sendEvent(response, "tool-input-available", {
    toolName: projectInfoTool.name,
    input: toolInput,
  });

  let toolOutput;

  try {
    const parsedInput = projectInfoTool.parameters.parse(toolInput);

    if (sabotage === "tool-failure") {
      throw new Error("The project information service is unavailable.");
    }

    toolOutput = await projectInfoTool.execute(parsedInput, settings);

    sendEvent(response, "tool-output-available", {
      toolName: projectInfoTool.name,
      output: toolOutput,
    });
  } catch (error) {
    if (sabotage !== "tool-failure") {
      console.error("[assistant/stream] tool execution failed", error);
    }

    sendEvent(response, "tool-error", {
      toolName: projectInfoTool.name,
      message:
        error instanceof Error && error.message
          ? error.message
          : "The tool failed to run.",
      code: "tool_execution_failed",
      retryable: true,
    });

    return;
  }

  const finalMessages = [
    ...messages,
    toolResponse.choices[0].message,
    {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(toolOutput),
    },
  ];

  const finalStream = await aiClient.chat.completions.create(
    createAiRequest(finalMessages),
    { signal: abortController.signal },
  );

  for await (const chunk of finalStream) {
    if (isDisconnected()) return;

    const text = chunk.choices?.[0]?.delta?.content;

    if (text) sendEvent(response, "text", { text });
  }
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
module.exports.SABOTAGE_MODES = SABOTAGE_MODES;