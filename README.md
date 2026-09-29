# AI Capstone — Production Project Assistant

A small production-oriented AI application that helps a developer inspect and understand the current configuration of a project through a streaming AI assistant and a structured server-side tool.

## Project brief

The Project Assistant solves a practical developer-facing problem: understanding current project configuration without manually navigating settings. It is intended for developers or team members joining an existing project who need quick, reliable answers about project name, developer, theme, and notification settings. I chose the idea because it gives the AI a meaningful job—retrieving real application state through a controlled tool—rather than using an LLM as a generic chatbot.

## Live application

- Production URL: https://ai-capstone-ten.vercel.app/
- Repository: https://github.com/BasitAchak/ai-capstone

The application is deployed with Vercel and exposes the Express API and static frontend through the same deployment.

## Tech stack

- Node.js
- Express
- HTML, CSS, vanilla JavaScript
- Groq OpenAI-compatible API
- `openai` SDK
- Zod for tool-input validation
- Vitest + Testing Library
- Playwright
- Node's built-in test runner + Supertest
- GitHub Actions
- Vercel

## Local setup

Requirements: Node.js 18+ and a Groq API key.

```bash
npm install
```

Create `.env` from the example:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Set:

```text
GROQ_API_KEY=your_key_here
```

Start the development server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

For a normal production-style local run:

```bash
npm start
```

## Architecture

```text
Browser
  |
  | GET / and /settings.html
  v
Express server
  |
  +--> Settings API
  |      GET  /api/settings
  |      PUT  /api/settings
  |
  +--> Assistant API
         POST /api/assistant/stream
              |
              +--> validate request
              +--> choose plain-chat or tool flow
              +--> Groq / openai/gpt-oss-20b
              +--> optional get_project_info tool
              +--> stream NDJSON events
              v
           Browser renderer
              |
              +--> text
              +--> tool lifecycle
              +--> retry/error states
```

### Main files

| File | Responsibility |
|---|---|
| `src/server.js` | Express app, settings API, assistant endpoint, validation, streaming and failure handling |
| `src/ai.js` | Groq client, model configuration and AI system prompt |
| `src/tools/project-info.js` | Zod schema and `get_project_info` server-side tool |
| `public/index.html` | Main assistant UI and accessibility structure |
| `public/js/app.js` | Streaming renderer, tool states, retry/stop behavior and client-side failure handling |
| `public/settings.html` | Project settings form |
| `public/js/settings.js` | Settings loading, validation and saving |
| `test/*.test.js` | Backend and resilience tests |
| `test/ui.test.jsx` | Browser UI tests with Vitest + Testing Library |
| `e2e/primary-flow.spec.js` | Playwright critical user-flow test |
| `.github/workflows/test.yml` | Automated CI test workflow |
| `vercel.json` | Vercel server/static routing configuration |
| `FAILURE-STATES.md` | Failure-state inventory and manual review script |

## AI integration

The AI is not used as a decorative chat box. The application gives it a defined task: answer questions about the current project and retrieve current settings when necessary.

The assistant uses Groq's OpenAI-compatible API with:

```text
openai/gpt-oss-20b
```

The central system prompt tells the model that it is the Project Assistant, describes the available settings, instructs it not to invent current values, and directs current-setting questions toward the `get_project_info` tool.

The relevant prompt is maintained centrally in `src/ai.js`.

### Structured tool

`get_project_info` is a server-side function. It accepts:

```json
{
  "includeNotifications": true
}
```

The input is validated with Zod before execution. The tool reads the application's current settings and returns structured data containing the project name, developer name, theme, and optionally notification status.

The browser receives explicit NDJSON lifecycle events:

1. `tool-input-streaming`
2. `tool-input-available`
3. `tool-output-available`
4. `text`
5. `done`

Tool failures are represented as `tool-error` events rather than uncaught exceptions.

## Resilience and safe failure

The application deliberately handles:

- offline requests
- provider outages
- rate limiting
- missing AI configuration
- mid-stream interruption
- slow responses
- hanging responses
- empty AI responses
- malformed tool arguments
- tool execution failure
- empty input
- oversized input
- first-run empty state
- unexpected client errors

A failed stream keeps already-received text instead of discarding it. Retry actions operate on the failed message and are disabled while retrying to avoid accidental double submissions.

The full failure inventory and reproduction instructions are in `FAILURE-STATES.md`.

The deployed failure-testing panel is intended for review/demo purposes. Set `SABOTAGE_DISABLED=1` when the injection mechanism should be disabled.

## Testing

The project has three test layers.

### Backend/resilience

```bash
npm test
```

This covers settings validation, API behavior, streaming format, provider failures, rate limiting, empty responses, malformed tool arguments, tool failures, and oversized-input protection.

### UI/component tests

```bash
npm run test:unit
```

The Vitest + Testing Library suite covers pending UI, streamed text, provider errors, tool lifecycle rendering, tool errors, partial-stream failures, and settings validation/saving.

### End-to-end

```bash
npm run test:e2e
```

Playwright verifies the critical flow: load the application, choose a project-info starter, send the request, and render the resulting AI response.

Run the complete suite with:

```bash
npm run test:all
```

## Accessibility and performance

The frontend was designed around the FE-10 accessibility principles:

- semantic headings and forms
- associated labels
- `aria-live` for assistant output
- `role="alert"` for important errors
- keyboard-accessible controls
- visible focus states
- mobile-safe viewport handling
- 16px input text to avoid mobile Safari zoom
- safe-area support for notched devices
- reduced layout movement during streaming

Before final submission, record the final Lighthouse and WAVE/axe results in the submission document. A concrete improvement from the audit work was replacing fragile mobile viewport/layout behavior with `100dvh`, safe-area insets and visual-viewport keyboard handling so the composer remains usable on mobile.

## Deployment and operations

The project is deployed through Vercel.

Deployment checklist:

1. Dependencies install successfully.
2. Tests pass locally.
3. Environment variable `GROQ_API_KEY` is configured in the deployment environment.
4. No API key is committed to source control.
5. Production URL loads successfully.
6. Primary AI flow works.
7. Error states are reviewed.
8. Lighthouse and accessibility audits are recorded.
9. GitHub Actions provides a repeatable test check.

### Rollback plan

The deployment is connected to Git. If a production deployment introduces a regression:

1. identify the last known-good commit/deployment in Vercel;
2. redeploy that known-good commit, or revert the offending commit on the production branch;
3. rerun the primary-flow and test checks;
4. verify the production URL before considering the rollback complete.

For a small project, redeploying the last known-good Git commit is the intended rollback mechanism.

## Known limitations and future improvements

- Settings persistence on Vercel is intentionally limited because serverless instances should not be treated as a permanent writable filesystem.
- The application currently has one focused AI tool rather than a larger tool ecosystem.
- The AI provider is external, so provider outages and rate limits remain possible.
- The next version could move settings to a persistent database.
- Additional authenticated users/roles could be added.
- More domain-specific tools could be introduced if the product scope grows.
- Automated production monitoring could be added beyond deployment/test checks.

## Repository hygiene

Do not commit `.env` or API keys. Use `.env.example` as the configuration template.

## License

See `LICENCE`.
