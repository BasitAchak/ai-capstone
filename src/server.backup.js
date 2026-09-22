const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const {
  createAiClient,
  createAiRequest,
  createToolRequest,
} = require("./ai");

const {
  projectInfoTool,
} = require("./tools/project-info");

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
  const previousMessages = Array.isArray(body.messages)
    ? body.messages
    : [];

  const safeMessages = previousMessages
    .filter(
      (message) =>
        message &&
        ["user", "assistant"].includes(message.role),
    )
    .filter(
      (message) =>
        typeof message.content === "string" &&
        message.content.trim(),
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

function sendEvent(response, type, data = {}) {
  response.write(
    `${JSON.stringify({
      type,
      ...data,
    })}\n`,
  );
}

function createApp(options = {}) {
  const settingsPath =
    options.settingsPath ||
    path.join(__dirname, "..", "data", "settings.json");

  const publicPath =
    options.publicPath ||
    path.join(__dirname, "..", "public");

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
      notificationsEnabled:
        request.body.notificationsEnabled === true,
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
      return response
        .status(400)
        .json({ error: validationError });
    }

    const aiClient =
      options.aiClient !== undefined
        ? options.aiClient
        : createAiClient();

    if (!aiClient) {
      return response
        .status(503)
        .json({ error: "The assistant is not configured." });
    }

    const messages = normalizeConversation(request.body);

    /*
     * We first use the normal streaming request.
     *
     * This preserves the existing assistant behavior and tests.
     * Tool-enabled requests are detected through an explicit command
     * in the user's message for this assignment.
     */
    const wantsTool =
      /\b(project info|project information|current settings|show.*settings|tool test)\b/i.test(
        request.body.message,
      );

    /*
     * NORMAL ASSISTANT FLOW
     */
    if (!wantsTool) {
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
          createAiRequest(messages),
          {
            signal: abortController.signal,
          },
        );

        response.status(200);
        response.setHeader(
          "Content-Type",
          "text/plain; charset=utf-8",
        );
        response.setHeader(
          "Cache-Control",
          "no-cache, no-transform",
        );
        response.setHeader(
          "X-Content-Type-Options",
          "nosniff",
        );
        response.flushHeaders();

        for await (const chunk of stream) {
          if (disconnected) break;

          const text = chunk.choices[0]?.delta?.content;

          if (text) {
            response.write(text);
          }
        }
      } catch (error) {
        if (!disconnected && !abortController.signal.aborted) {
          if (!response.headersSent) {
            response
              .status(502)
              .json({
                error:
                  "The assistant provider is unavailable.",
              });
          } else {
            response.write(
              "\n\nThe assistant could not complete this response.",
            );
          }
        }
      } finally {
        if (!disconnected) {
          response.end();
        }
      }

      return;
    }

    /*
     * TOOL FLOW
     */
    const abortController = new AbortController();
    let disconnected = false;

    response.on("close", () => {
      if (!response.writableEnded) {
        disconnected = true;
        abortController.abort();
      }
    });

    try {
      response.status(200);
      response.setHeader(
        "Content-Type",
        "application/x-ndjson; charset=utf-8",
      );
      response.setHeader(
        "Cache-Control",
        "no-cache, no-transform",
      );
      response.setHeader(
        "X-Content-Type-Options",
        "nosniff",
      );
      response.flushHeaders();

      /*
       * STATE 1 — INPUT STREAMING
       */
      sendEvent(response, "tool-input-streaming", {
        toolName: projectInfoTool.name,
      });

      let toolResponse;

      try {
        toolResponse =
          await aiClient.chat.completions.create(
            createToolRequest(messages),
            {
              signal: abortController.signal,
            },
          );
      } catch (error) {
        if (!disconnected) {
          sendEvent(response, "tool-error", {
            toolName: projectInfoTool.name,
            message: "The tool could not be reached.",
          });
        }

        return;
      }

      if (disconnected) return;

      const toolCall =
        toolResponse.choices[0]?.message?.tool_calls?.[0];

      /*
       * If the provider doesn't select the tool, still return
       * a useful response rather than crashing.
       */
      if (!toolCall) {
        const fallback =
          toolResponse.choices[0]?.message?.content ||
          "The assistant did not request a tool.";

        sendEvent(response, "text", {
          text: fallback,
        });

        return;
      }

      let toolInput;

      try {
        toolInput = JSON.parse(
          toolCall.function.arguments || "{}",
        );
      } catch {
        sendEvent(response, "tool-error", {
          toolName: projectInfoTool.name,
          message: "The tool received invalid input.",
        });

        return;
      }

      /*
       * STATE 2 — INPUT AVAILABLE
       */
      sendEvent(response, "tool-input-available", {
        toolName: projectInfoTool.name,
        input: toolInput,
      });

      let toolOutput;

      try {
        const parsedInput =
          projectInfoTool.parameters.parse(toolInput);

        toolOutput = await projectInfoTool.execute(
          parsedInput,
          currentSettings,
        );

        /*
         * STATE 3 — OUTPUT AVAILABLE
         */
        sendEvent(response, "tool-output-available", {
          toolName: projectInfoTool.name,
          output: toolOutput,
        });
      } catch (error) {
        /*
         * STATE 4 — OUTPUT ERROR
         */
        sendEvent(response, "tool-error", {
          toolName: projectInfoTool.name,
          message:
            error instanceof Error
              ? error.message
              : "The tool failed.",
        });

        return;
      }

      /*
       * Give the model the tool result and stream its
       * final natural-language response.
       */
      const finalMessages = [
        ...messages,
        toolResponse.choices[0].message,
        {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolOutput),
        },
      ];

      const finalStream =
        await aiClient.chat.completions.create(
          createAiRequest(finalMessages),
          {
            signal: abortController.signal,
          },
        );

      for await (const chunk of finalStream) {
        if (disconnected) break;

        const text = chunk.choices[0]?.delta?.content;

        if (text) {
          sendEvent(response, "text", { text });
        }
      }
    } catch (error) {
      if (!disconnected && !abortController.signal.aborted) {
        sendEvent(response, "error", {
          message:
            "The assistant could not complete this response.",
        });
      }
    } finally {
      if (!disconnected) {
        response.end();
      }
    }
  });

  return app;
}

const app = createApp();

if (require.main === module) {
  const port = process.env.PORT || 3000;

  app.listen(port, () => {
    console.log(
      `Server running at http://localhost:${port}`,
    );
  });
}

module.exports = app;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
module.exports.createApp = createApp;
module.exports.validateRequiredName =
  validateRequiredName;
module.exports.validateSettings = validateSettings;
module.exports.validateAssistantRequest =
  validateAssistantRequest;