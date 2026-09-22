const OpenAI = require("openai");
const { getProjectInfoToolDefinition } = require("./tools/project-info");

const GROQ_MODEL = "openai/gpt-oss-20b";
const GROQ_MAX_TOKENS = 1024;
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

const PROJECT_SETTINGS_SYSTEM_PROMPT = `You are the Project Assistant for the AI Capstone Project settings page.

The application has these settings:
- projectName: required text project name
- developerName: required text developer name
- theme: light or dark
- notificationsEnabled: boolean

You have access to a server-side tool called get_project_info.

Use get_project_info whenever the user asks for current project information or current settings.

Never invent current setting values. When current values are needed, use the tool.

The assistant cannot change settings.

Be concise and factual.`;

function createAiClient(apiKey = process.env.GROQ_API_KEY) {
  if (!apiKey) return null;

  return new OpenAI({
    apiKey,
    baseURL: GROQ_BASE_URL,
  });
}

function createAiRequest(messages) {
  return {
    model: GROQ_MODEL,
    max_tokens: GROQ_MAX_TOKENS,
    stream: true,
    messages: [
      {
        role: "system",
        content: PROJECT_SETTINGS_SYSTEM_PROMPT,
      },
      ...messages,
    ],
    /*
     * This request never attaches the tool definition, but the system prompt
     * mentions get_project_info by name so the model can be seen trying to
     * call it anyway. Groq rejects that outright ("Tool choice is none, but
     * model called a tool") since no tools array was offered. tool_choice:
     * "none" tells the model explicitly not to attempt a call here, closing
     * the gap between what the prompt describes and what this request offers.
     */
    tool_choice: "none",
  };
}

function createToolRequest(messages) {
  return {
    model: GROQ_MODEL,
    max_tokens: GROQ_MAX_TOKENS,
    stream: false,
    messages: [
      {
        role: "system",
        content: PROJECT_SETTINGS_SYSTEM_PROMPT,
      },
      ...messages,
    ],
    tools: [getProjectInfoToolDefinition()],
    tool_choice: "auto",
  };
}

module.exports = {
  GROQ_MODEL,
  PROJECT_SETTINGS_SYSTEM_PROMPT,
  createAiClient,
  createAiRequest,
  createToolRequest,
};