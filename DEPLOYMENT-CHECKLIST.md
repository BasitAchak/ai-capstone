# Production Deployment Checklist

Project: AI Capstone — Project Assistant
Developer: Abdul Basit
Production URL: https://ai-capstone-ten.vercel.app/
Repository: https://github.com/BasitAchak/ai-capstone

## Pre-deployment

- [x] Production application exists and is deployed.
- [x] AI provider integration is implemented server-side.
- [x] API key is read from environment configuration rather than browser code.
- [x] `.env` is excluded from source control.
- [x] Input validation exists.
- [x] Provider/API error handling exists.
- [x] Streaming failure handling exists.
- [x] Tool input is validated with Zod.
- [x] Automated backend tests exist.
- [x] UI tests exist.
- [x] Playwright critical-flow test exists.
- [x] GitHub Actions test workflow exists.
- [x] Vercel configuration exists.

## Production verification

- [ ] Open production URL successfully.
- [ ] Send a normal assistant message.
- [ ] Use Project info / Current settings flow.
- [ ] Confirm structured project information renders.
- [ ] Confirm retry/error UI is understandable.
- [ ] Confirm Stop works during a slow/hanging response.
- [ ] Run final Lighthouse audit and record score.
- [ ] Run final WAVE or axe audit and confirm no WCAG AA violations.
- [ ] Capture screenshots for the final submission.

## Failure-safety verification

- [x] Missing API configuration returns a controlled 503 response.
- [x] Rate-limit condition has a retryable error state.
- [x] Provider failure has a retryable error state.
- [x] Mid-stream interruption keeps partial content.
- [x] Empty provider output is reported instead of rendered as silence.
- [x] Malformed tool arguments produce a designed tool error.
- [x] Tool execution failure produces a designed tool error.
- [x] Oversized input is rejected before reaching the provider.
- [x] Offline state has a user-facing message.
- [x] Unexpected client errors have a reload path.

## Rollback

Rollback method: redeploy the last known-good Git commit/deployment through Vercel.

- [x] Rollback method documented.
- [ ] Final production deployment checked after any last-minute changes.

## Sign-off

Developer: Abdul Basit  
Date: ____________________  
Final production URL verified: ____________________  
Lighthouse score: ____________________  
Accessibility result: ____________________  
Final test result: ____________________
