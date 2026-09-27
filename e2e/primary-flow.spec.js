import { test, expect } from '@playwright/test';

test('primary flow: choose a starter, send a message, and render the AI response', async ({ page }) => {
  await page.route('**/api/assistant/stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: [
        JSON.stringify({ type: 'text', text: 'Your project is configured and ready.' }),
        JSON.stringify({ type: 'done' }),
      ].join('\n') + '\n',
    });
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Ask about this project' })).toBeVisible();

  await page.getByRole('button', { name: 'Show project settings' }).click();
  const input = page.getByLabel('Message the assistant');
  await expect(input).toHaveValue('Show me the current project settings.');

  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('Your project is configured and ready.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
});
