const { z } = require("zod");

const projectInfoInputSchema = z.object({
  includeNotifications: z
    .boolean()
    .describe("Whether to include the notification setting in the result."),
});

const projectInfoTool = {
  name: "get_project_info",
  description:
    "Get the current project settings from the application. Use this when the user asks for project information, current settings, theme, developer name, or notification status.",
  parameters: projectInfoInputSchema,

  async execute(input, settings) {
    if (!settings) {
      throw new Error("Project settings are unavailable.");
    }

    // Deliberate failure trigger for demonstrating the designed error state.
    if (settings.projectName === "__TOOL_ERROR_TEST__") {
      throw new Error("The project information service is temporarily unavailable.");
    }

    const result = {
      projectName: settings.projectName,
      developerName: settings.developerName,
      theme: settings.theme,
    };

    if (input.includeNotifications) {
      result.notificationsEnabled = settings.notificationsEnabled;
    }

    return result;
  },
};

function getProjectInfoToolDefinition() {
  return {
    type: "function",
    function: {
      name: projectInfoTool.name,
      description: projectInfoTool.description,
      parameters: z.toJSONSchema(projectInfoInputSchema),
    },
  };
}

module.exports = {
  projectInfoInputSchema,
  projectInfoTool,
  getProjectInfoToolDefinition,
};