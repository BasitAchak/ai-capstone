import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, renderSettings, jsonResponse, streamResponse } from "./helpers/browser-fixtures.jsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Project Assistant chat renderer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  test("renders the pending state while the AI request is waiting", async () => {
    fetch.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    await renderApp();

    const input = screen.getByLabelText("Message the assistant");
    await user.type(input, "Hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByText("Assistant is responding")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
  });

  test("replaces the pending skeleton with streamed assistant text", async () => {
    fetch.mockResolvedValue(
      streamResponse([
        { type: "text", text: "Hello " },
        { type: "text", text: "from the assistant." },
        { type: "done" },
      ]),
    );
    const user = userEvent.setup();
    await renderApp();

    await user.type(screen.getByLabelText("Message the assistant"), "Hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByText("Hello from the assistant.")).toBeInTheDocument();
    });
    expect(screen.queryByText("Assistant is responding")).not.toBeInTheDocument();
  });

  test("renders a retryable error when the AI route returns an error", async () => {
    fetch.mockResolvedValue(
      jsonResponse(
        {
          error: "The assistant provider is unavailable.",
          code: "provider_unavailable",
          retryable: true,
        },
        502,
      ),
    );
    const user = userEvent.setup();
    await renderApp();

    await user.type(screen.getByLabelText("Message the assistant"), "Hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(
        screen.getByText("The assistant provider is unavailable."),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Retry this message" })).toBeInTheDocument();
  });

  test("renders the complete tool lifecycle and structured project result", async () => {
    fetch.mockResolvedValue(
      streamResponse([
        {
          type: "tool-input-streaming",
          toolName: "get_project_info",
          input: { includeNotifications: true },
        },
        {
          type: "tool-input-available",
          toolName: "get_project_info",
          input: { includeNotifications: true },
        },
        {
          type: "tool-output-available",
          toolName: "get_project_info",
          output: {
            projectName: "AI Capstone Project",
            developerName: "Abdul Basit",
            theme: "dark",
            notificationsEnabled: true,
          },
        },
        { type: "text", text: "Here are the current settings." },
        { type: "done" },
      ]),
    );
    const user = userEvent.setup();
    await renderApp();

    await user.type(
      screen.getByLabelText("Message the assistant"),
      "Show the current project settings.",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByText("Project information")).toBeInTheDocument();
    });

    expect(screen.getByText("Project information")).toBeInTheDocument();
    expect(screen.getByText("Tool returned structured data")).toBeInTheDocument();
    expect(screen.getByText("AI Capstone Project")).toBeInTheDocument();
    expect(screen.getByText("Abdul Basit")).toBeInTheDocument();
    expect(screen.getByText("dark")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
});

  test("renders a retryable tool error instead of crashing", async () => {
    fetch.mockResolvedValue(
      streamResponse([
        {
          type: "tool-error",
          toolName: "get_project_info",
          message: "The project information service is temporarily unavailable.",
          code: "tool_execution_failed",
          retryable: true,
        },
      ]),
    );
    const user = userEvent.setup();
    await renderApp();

    await user.type(
      screen.getByLabelText("Message the assistant"),
      "Show the current project settings.",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByText("Tool did not complete")).toBeInTheDocument();
    });
    expect(
      screen.getByText("The project information service is temporarily unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry this message" })).toBeInTheDocument();
  });

  test("keeps partial streamed text when the stream ends with an error", async () => {
    fetch.mockResolvedValue(
      streamResponse([
        { type: "text", text: "This part arrived before " },
        {
          type: "error",
          message: "The connection was interrupted.",
          code: "stream_interrupted",
          retryable: true,
        },
      ]),
    );
    const user = userEvent.setup();
    await renderApp();

    await user.type(screen.getByLabelText("Message the assistant"), "Tell me more");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByText("This part arrived before")).toBeInTheDocument();
    });
    expect(screen.getByText("Response was cut off")).toBeInTheDocument();
    expect(screen.getByText("The connection was interrupted.")).toBeInTheDocument();
  });
});

describe("Project settings validated form", () => {
  test("shows validation errors for blank required fields and saves valid data", async () => {
    const requests = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      if (!options) {
        return jsonResponse({
          projectName: "AI Capstone Project",
          developerName: "Abdul Basit",
          theme: "light",
          notificationsEnabled: true,
        });
      }

      requests.push({ url, options });
      return jsonResponse({
        projectName: "Updated Project",
        developerName: "Updated Developer",
        theme: "dark",
        notificationsEnabled: false,
      });
    }));

    const user = userEvent.setup();
    await renderSettings();

    await waitFor(() => {
      expect(screen.getByLabelText("Project name")).toHaveValue("AI Capstone Project");
    });

    const projectName = screen.getByLabelText("Project name");
    const developerName = screen.getByLabelText("Developer name");

    await user.clear(projectName);
    await user.clear(developerName);
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(screen.getByText("Project name is required.")).toBeInTheDocument();
    expect(screen.getByText("Developer name is required.")).toBeInTheDocument();
    expect(requests).toHaveLength(0);

    await user.type(projectName, "Updated Project");
    await user.type(developerName, "Updated Developer");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
  expect(
    screen.getByText("Settings saved successfully.")
  ).toBeInTheDocument();
});
    expect(requests[0].url).toBe("/api/settings");
    expect(requests[0].options.method).toBe("PUT");
  });
});
