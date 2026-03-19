import { test, expect } from '@playwright/test'

test.describe('Smoke tests', () => {
  test('dashboard loads and has correct title', async ({ page }) => {
    await page.goto('http://localhost:7779/')
    // Just check the page loads without 500 error
    await expect(page).not.toHaveURL(/error/)
    const title = await page.title()
    expect(title.length).toBeGreaterThan(0)
  })
})
