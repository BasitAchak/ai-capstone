import React from "react";
import { render } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function makeStream(lines) {
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index >= lines.length) return { value: undefined, done: true };
          const line = lines[index++];
          return { value: new TextEncoder().encode(`${line}\n`), done: false };
        },
      };
    },
  };
}

export function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

export function streamResponse(events) {
  return {
    ok: true,
    status: 200,
    body: makeStream(events.map((event) => JSON.stringify(event))),
  };
}

function AppShell() {
  return (
    <main>
      <div id="connection-banner" role="status" hidden />
      <div id="app-error" role="alert" hidden>
        <div>
          <strong>The page hit an unexpected error</strong>
          <p className="app-error-detail" />
        </div>
        <button id="app-error-reload" type="button">Reload</button>
      </div>
      <section className="assistant-card">
        <div id="messages" aria-live="polite" />
        <form id="assistant-form">
          <label htmlFor="message-input">Message the assistant</label>
          <input id="message-input" name="message" />
          <button id="send-button" type="submit">Send</button>
          <button id="stop-button" type="button" hidden>Stop</button>
        </form>
        <div className="quick-actions" />
        <select id="sabotage-mode" aria-label="Failure mode">
          <option value="">None</option>
        </select>
      </section>
    </main>
  );
}

function SettingsShell() {
  return (
    <main>
      <section>
        <form id="settings-form">
          <label htmlFor="projectName">Project name</label>
          <input id="projectName" name="projectName" />
          <p id="projectName-error" role="alert" />
          <label htmlFor="developerName">Developer name</label>
          <input id="developerName" name="developerName" />
          <p id="developerName-error" role="alert" />
          <label htmlFor="theme">Theme</label>
          <select id="theme" name="theme">
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          <label htmlFor="notificationsEnabled">Enable notifications</label>
          <input id="notificationsEnabled" name="notificationsEnabled" type="checkbox" />
          <button type="submit">Save settings</button>
          <button type="button" id="reset-button">Reset</button>
          <p id="status" role="status" />
        </form>
      </section>
      <section>
        <div id="assistant-messages" aria-label="Assistant conversation" />
        <p id="assistant-thinking" hidden>Thinking...</p>
        <form id="assistant-form">
          <label htmlFor="assistant-input">Ask about your project settings</label>
          <textarea id="assistant-input" />
          <button type="submit" id="assistant-send">Send</button>
          <button type="button" id="assistant-stop" disabled>Stop</button>
          <p id="assistant-status" role="status" />
        </form>
      </section>
    </main>
  );
}

async function loadScript(relativePath) {
  const script = fs.readFileSync(path.join(root, relativePath), "utf8");
  // app.js/settings.js are browser scripts. Running them as a function keeps
  // their top-level state isolated for each test while using the jsdom globals.
  new Function(script)();
}

export async function renderApp() {
  const view = render(<AppShell />);
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  await loadScript("public/js/app.js");
  return view;
}

export async function renderSettings() {
  const view = render(<SettingsShell />);
  await loadScript("public/js/settings.js");
  return view;
}
