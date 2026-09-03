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