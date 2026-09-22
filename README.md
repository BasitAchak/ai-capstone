# AI Capstone Project

Repository for the **AI-assisted Software Engineering Internship** capstone.

## Overview

This project applies modern software engineering practices—version control, collaborative workflows, and maintainable code—with AI-assisted development tools.

## Tech Stack

- Node.js
- Git & GitHub
- Visual Studio Code
- Claude Code

## Getting Started

Install the declared dependencies and start the local server:

```sh
npm install
npm start
```

Open `http://localhost:3000` in a browser. Project preferences are available
from the home page and are persisted in `data/settings.json`.

Run the automated tests with:

```sh
npm test
```

## Project Assistant

The settings page includes a streaming Project Assistant powered by Groq.
Copy `.env.example` to `.env` and set `GROQ_API_KEY` before starting the
server:

```sh
copy .env.example .env
```

Keep the key in `.env`; it is loaded only by the server and is never sent to
browser JavaScript. The assistant uses Groq's OpenAI-compatible API with the
`openai/gpt-oss-20b` streaming model. It can discuss project settings and
suggest changes, but settings are never changed automatically by an AI response.


## Project Status

The project includes a small Express application with a home page and a
Project Settings page for project identity, theme, and notifications.

## Generative UI Tool

This project includes a server-side tool called `get_project_info`.

### Tool Contract

**Tool name:** `get_project_info`

**Purpose:** Retrieves the current project settings and returns them as structured data for the UI.

**Input schema:**

```json
{
  "includeNotifications": "boolean"
}

## Resilience

Failure and edge cases in the assistant flow are handled deliberately rather
than left to defaults: offline sends, mid-stream interruption, rate limiting,
provider outage, malformed tool output, slow and hanging responses, empty
responses, empty input, and first-run empty state.

Each one is reproducible on the deployed URL from the **Failure testing**
panel at the bottom of the page. See `FAILURE-STATES.md` for the full
inventory, the review script, and the reasoning behind each decision.

Set `SABOTAGE_DISABLED=1` to remove the injection mechanism in production.

The assistant stream is newline-delimited JSON for both the chat and tool
flows, so a connection dropped mid-token leaves an incomplete line buffered
rather than rendering as broken text.
