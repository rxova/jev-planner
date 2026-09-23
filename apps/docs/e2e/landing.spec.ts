import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Paths are relative to baseURL, which carries the base; a leading `/` would
// drop it and test the domain root instead of the site.
const LANDING = './'
const DOCS = 'guides/getting-started/'
// The pages with inline diagrams, which take their colours from the theme.
const DIAGRAMS = ['learn/how-it-works/', 'guides/debate-review/']

/** The pathname every same-site URL must start with. */
const basePath = (page: Page) => new URL(LANDING, page.url()).pathname

const setTheme = (page: Page, theme: 'light' | 'dark') =>
  page.addInitScript((t) => {
    localStorage.setItem('starlight-theme', t)
  }, theme)

for (const theme of ['light', 'dark'] as const) {
  test(`has no serious or critical axe violations in the ${theme} theme`, async ({ page }) => {
    await setTheme(page, theme)
    // Reduced motion, so the scan sees the transcript at full opacity.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const path of [LANDING, DOCS, ...DIAGRAMS]) {
      await page.goto(path)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze()
      const blocking = violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
      expect(blocking, `${path} in ${theme}`).toEqual([])
    }
  })
}

test('uses the logo for the home link', async ({ page }) => {
  await page.goto(LANDING)

  const home = page.getByRole('link', { name: 'jev-planner', exact: true })
  await expect(home).toBeVisible()
  const logo = home.locator('img:visible')
  await expect(logo).toHaveCount(1)
  // A broken image is still visible; one that decoded has a width.
  expect(await logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
})

test('serves a favicon that renders', async ({ page }) => {
  await page.goto(LANDING)
  const href = await page.locator('link[rel~="icon"]').first().getAttribute('href')
  expect(href).toBeTruthy()
  const width = await page.evaluate((src) => {
    const img = new Image()
    img.src = src
    return img.decode().then(
      () => img.naturalWidth,
      () => 0,
    )
  }, href ?? '')
  expect(width).toBeGreaterThan(0)
})

test('wears the rxova brand', async ({ page }) => {
  await page.goto(LANDING)

  // The gradient's one placement on this site: the hairline under the header.
  const hairline = await page
    .locator('header.header')
    .evaluate((el) => getComputedStyle(el, '::after').backgroundImage)
  expect(hairline).toMatch(/^linear-gradient/)

  // Starlight's accent resolves to the brand violet, not its own blue or the old orange.
  const [accent, primary] = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return ['--sl-color-accent', '--rx-primary'].map((name) => style.getPropertyValue(name).trim())
  })
  expect(primary).toMatch(/^#[0-9a-f]{6}$/i)
  expect(accent).toBe(primary)
})

test('paints the text in the brand face on the first visit', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'reads the painted font over the Chrome DevTools Protocol')
  // `font-display: optional` drops a face that arrives late, and a loaded face
  // is not proof of a painted one — so ask the renderer what it drew with.
  const cdp = await page.context().newCDPSession(page)
  for (const path of [LANDING, DOCS]) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument')
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'h1' })
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
    expect(
      fonts.map((f) => f.familyName),
      path,
    ).toEqual([expect.stringMatching(/^Space Grotesk/)])
  }
})

test('reaches the calls to action in reading order from the keyboard', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'no Tab key on a phone')
  await page.goto(LANDING)

  const order: string[] = []
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab')
    const id = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return ''
      if (el.closest('.hero') && el.textContent.includes('Get started')) return 'get-started'
      if (el.closest('[data-copy-command]')) return 'copy'
      if (el.closest('.terminal')) return 'transcript'
      if (el.closest('.features')) return `feature:${el.textContent.trim()}`
      return ''
    })
    if (id && !order.includes(id)) order.push(id)
  }

  // The transcript leads the page, so it is the first stop, then the calls to action.
  expect(order.slice(0, 3)).toEqual(['transcript', 'get-started', 'copy'])
  expect(order.filter((id) => id.startsWith('feature:'))).toHaveLength(4)
})

test('says the command was copied', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(LANDING)

  await page.getByRole('button', { name: 'Copy' }).click()
  await expect(page.getByRole('status')).toHaveText('Copied to clipboard')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'npm install -g jev-planner',
  )
})

test('selects the command when the clipboard refuses', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
    })
  })
  await page.goto(LANDING)

  await page.getByRole('button', { name: 'Copy' }).click()
  await expect(page.getByRole('status')).toContainText('the command is selected')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    'npm install -g jev-planner',
  )
})

test('keeps the chosen theme from the landing page to a docs page', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'the picker is inside the menu on mobile')
  await page.goto(LANDING)
  const current = await page.locator('html').getAttribute('data-theme')
  const other = current === 'dark' ? 'light' : 'dark'

  await page.locator('starlight-theme-select select').first().selectOption(other)
  await expect(page.locator('html')).toHaveAttribute('data-theme', other)

  await page.getByRole('link', { name: 'Get started' }).first().click()
  await expect(page).toHaveURL(/guides\/getting-started\/$/)
  await expect(page.locator('html')).toHaveAttribute('data-theme', other)
})

test('shows the whole transcript at once under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(LANDING)

  const lines = page.locator('.terminal .line')
  await expect(lines.first()).toBeVisible()
  const opacities = await lines.evaluateAll((els) => els.map((el) => getComputedStyle(el).opacity))
  expect(opacities.length).toBeGreaterThan(5)
  expect(new Set(opacities)).toEqual(new Set(['1']))
})

test('keeps the header in view while the page scrolls', async ({ page }) => {
  for (const path of [LANDING, DIAGRAMS[0]]) {
    await page.goto(path)
    await page.evaluate(() => {
      window.scrollTo(0, 1500)
    })
    await expect.poll(() => page.evaluate(() => window.scrollY), path).toBeGreaterThan(0)
    const top = await page.locator('header.header').evaluate((h) => h.getBoundingClientRect().top)
    expect(top, path).toBe(0)
  }
})

test('does not scroll sideways', async ({ page }) => {
  for (const path of [LANDING, DOCS, ...DIAGRAMS]) {
    await page.goto(path)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, path).toBeLessThanOrEqual(0)
  }
})

test('draws the diagrams in the theme, with text a phone can read', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  for (const path of DIAGRAMS) {
    await page.goto(path)
    const svgs = page.locator('figure.diagram svg')
    expect(await svgs.count(), path).toBeGreaterThan(0)
    for (const svg of await svgs.all()) {
      await expect(svg).toHaveAttribute('role', 'img')
      const { fill, smallest } = await svg.evaluate((el) => {
        const scale = el.getBoundingClientRect().width / (el as SVGSVGElement).viewBox.baseVal.width
        const sizes = [...el.querySelectorAll('text')].map(
          (t) => parseFloat(getComputedStyle(t).fontSize) * scale,
        )
        return {
          fill: getComputedStyle(el.querySelector('.box') ?? el).fill,
          smallest: Math.min(...sizes),
        }
      })
      // The boxes are painted from theme.css, not left at the SVG default.
      expect(fill, path).not.toMatch(/^(none|rgb\(0, 0, 0\))$/)
      expect(smallest, path).toBeGreaterThanOrEqual(12)
    }
  }
})

test('keeps the base on every same-site link and through navigation', async ({ page }) => {
  await page.goto(LANDING)
  const base = basePath(page)
  const origin = new URL(page.url()).origin

  const hrefs = await page
    .locator('a[href]')
    .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))
  const local = hrefs.filter((h) => h.startsWith(origin))
  expect(local.length).toBeGreaterThan(5)
  for (const href of local) expect(new URL(href).pathname, href).toMatch(new RegExp(`^${base}`))

  await page.locator('.features a').first().click()
  expect(new URL(page.url()).pathname.startsWith(base)).toBe(true)
  await expect(page.locator('h1')).not.toHaveText(/not found/i)
})

test('offers starring the repository as a call to action', async ({ page }) => {
  await page.goto(LANDING)

  const star = page.getByRole('link', { name: 'Star on GitHub' })
  await expect(star).toBeVisible()
  await expect(star).toHaveAttribute('href', 'https://github.com/rxova/jev-planner')
})

test('shows the four stages as a numbered list, in order', async ({ page }) => {
  await page.goto(LANDING)

  const items = page.locator('.features ol > li')
  await expect(items).toHaveCount(4)
  const numbers = await items.locator('h3 a .n').allTextContents()
  expect(numbers).toEqual(['1', '2', '3', '4'])
})

test('fits the quick start through its first command without scrolling', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'a phone scrolls; the point is the first screen')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(DOCS)

  // The install block: the reader should meet it without reaching for the mouse.
  const install = page.locator('.expressive-code').first()
  const bottom = await install.evaluate((el) => el.getBoundingClientRect().bottom)
  expect(bottom).toBeLessThanOrEqual(800)
})
