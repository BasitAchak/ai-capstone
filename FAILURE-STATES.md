# Failure states and how to reproduce them

Every failure path in the primary flow is reproducible on the deployed URL,
not just on a throttled laptop. Select a mode under **Failure testing** at the
bottom of the page and send a message; the mode is sent as an `x-sabotage`
header on that request.

Set `SABOTAGE_DISABLED=1` in the environment to disable injection entirely.

---

## The inventory

| # | Case | How to trigger | Designed response |
|---|------|----------------|-------------------|
| 1 | Network failure before send | DevTools → Network → Offline, then send | Offline banner; message kept with "You are offline" and a retry |
| 2 | Connection killed mid-stream | `mid-stream`, or DevTools offline while streaming | Partial text kept, "Response was cut off" beneath it, retry |
| 3 | Rate limited | `rate-limit` | HTTP 429 → "rate-limited, wait a few seconds", retry |
| 4 | Provider unavailable | `provider-down` | HTTP 502 → "provider is unavailable", retry |
| 5 | Malformed JSON from tool | `malformed-tool` | `tool-error` state, not a crash; retry |
| 6 | Tool execution failure | `tool-failure` | `tool-error` state with the failure reason; retry |
| 7 | Slow response | `slow` (6s) | Skeleton holds, Stop button available |
| 8 | Hanging response | `hang` | Client gives up after 25s → "did not respond", retry |
| 9 | Empty response | `empty` | "No response" state rather than a blank bubble |
| 10 | Empty input | Press Send with an empty box | No-op; focus returns to the input. Send is disabled while empty |
| 11 | First run / no conversation | Hard reload | Empty state with three click-to-fill starters |
| 12 | Unexpected script error | — | Page-level error banner with Reload |

---

## Review script

Run in this order. This is roughly the order a reviewer will follow.

1. **Happy path.** Hard reload → empty state renders → click a starter (it
   fills the input) → Send → skeleton → text streams in → console is clean.
2. **Kill network before send.** DevTools → Offline. Send. Offline banner
   appears, Send disables and reads "Offline". Go back online, press Retry.
3. **Kill mid-stream.** Set `mid-stream`, send. Partial text stays on screen
   with the error beneath it. Press Retry once; confirm the button disables
   and reads "Retrying…" and a second click does nothing.
4. **429.** Set `rate-limit`, send. Confirm the copy names the wait.
5. **Malformed tool JSON.** Set `malformed-tool`, send "Show me the current
   settings." Confirm a designed tool-error, not a stack trace.
6. **Empty conversation on first run.** Hard reload, confirm the empty state
   points somewhere useful.
7. **Stop.** Set `slow` or `hang`, send, press Stop. Confirm partial text is
   kept and framed as a choice, not a failure.

---

## Notes on specific decisions

**One wire format.** Both the chat flow and the tool flow stream
newline-delimited JSON. The previous version streamed raw text and signalled
failure with a `[[AI_STREAM_ERROR]]` marker inside the text — which could be
split across TCP chunks, so the client would miss the error and render half a
marker as assistant text. With NDJSON a line is either complete or still
buffered, so a truncated line can never render.

**Partial content is never discarded.** Mid-stream failure, stop, and
connection loss all keep whatever arrived and attach the explanation
underneath. Throwing away three good paragraphs because the fourth failed is
a worse outcome than the failure itself.

**Retry retries one message.** The failed user message, not the conversation.
The button disables on first click and states what it is doing, so a double
click is impossible rather than merely ignored.

**Skeleton matches real text.** Body text is 16px at line-height 1.5, so each
line occupies 24px. Each skeleton row is a 10px bar in a 24px slot, laid out
with flex `gap` rather than margins so adjacent margins cannot collapse and
shrink the box. Content replaces the skeleton inside the same element, so
nothing below it moves. CLS stays at 0 during the handoff.

**Auto-scroll yields to the user.** The log only follows the stream when the
reader is already within 64px of the bottom. Forcing scroll on every token
yanks the view away from someone reading earlier output, and on iOS it fights
rubber-band scrolling into a stutter.

### Mobile Safari

- `100dvh`, not `100vh`. `vh` on iOS resolves to the tallest viewport, so the
  bottom of a `100vh` layout sits underneath the browser chrome.
- The composer is a normal flex child of a full-height column, not
  `position: sticky`. Sticky inside an `overflow: hidden` card is unreliable,
  and the old version floated the composer behind the keyboard.
- `visualViewport` resize is tracked and exposed as `--keyboard-inset`, which
  the layout adds to its bottom padding. iOS shrinks the visual viewport on
  keyboard open without resizing the layout viewport, so this is the only way
  to keep the input visible.
- `overscroll-behavior: contain` on the message log keeps rubber-band scroll
  inside the log instead of dragging the whole page.
- Input font-size is 16px, below which Safari zooms the viewport on focus.
- `viewport-fit=cover` plus `env(safe-area-inset-*)` for notched devices.

---

## Automated coverage

`npm test` — 21 tests. The failure paths are covered so that a regression in
error handling is a red build rather than a bad demo:

- mid-stream failure emits a retryable error *after* partial text
- every streamed line is parseable JSON
- 429 and 502 carry machine-readable codes and a `retryable` flag
- malformed tool arguments produce a tool-error, not an exception
- an empty provider response is reported rather than rendered as silence
- oversized input never reaches the provider
