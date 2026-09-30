const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const {chromium} = require('playwright')

async function main() {
  const root = path.resolve(__dirname, '..')
  const source = fs.readFileSync(path.join(root, 'script.js'), 'utf8')
  const start = source.indexOf('function getCenteredHomeTimelineCss()')
  assert.ok(start >= 0, 'Centered Home layout must exist')
  const css = vm.runInNewContext(source.slice(start, source.indexOf('\n//#region CSS', start)) + ';getCenteredHomeTimelineCss()')
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'home-layout.html'), 'utf8')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    for (const width of [1920, 1600, 1440, 1280, 1203, 1024, 800, 700, 600]) {
      await page.setViewportSize({width, height: 800})
      await page.setContent(fixture.replace('__CENTERED_HOME_CSS__', css))
      const metrics = await page.evaluate(() => layoutMetrics())
      assert.ok(metrics.centerError < 1, `Feed must be centered at ${width}px: ${JSON.stringify(metrics)}`)
      assert.ok(Math.abs(metrics.search.center - metrics.feed.center) < 1, 'Search must align with the feed')
      assert.ok(metrics.searchAbove, 'Search must be above the feed')
      assert.ok(metrics.search.width <= 350, 'Search must remain compact')
      assert.equal(metrics.overflow, false, `No horizontal overflow at ${width}px`)
      await page.getByRole('textbox', {name: 'Search query'}).fill('test query')
      assert.equal(await page.getByRole('textbox', {name: 'Search query'}).inputValue(), 'test query')
      await page.evaluate(() => window.scrollTo(0, 250))
      const tabs = await page.locator('.tabs').boundingBox()
      assert.ok(Math.abs(tabs.y) < 1, 'Timeline tabs must remain sticky')
      console.log(`PASS: ${width}px, centered feed, compact search, no overflow, usable search and sticky tabs`)
    }
    // CSS must leave mobile and non-Home layouts alone.
    for (const classes of ['Mobile HomeTimeline Sidebar', 'Desktop Profile Sidebar', 'Desktop Search Sidebar']) {
      await page.setViewportSize({width: 1203, height: 800})
      await page.setContent(fixture.replace('__CENTERED_HOME_CSS__', ''))
      await page.evaluate(value => { document.body.className = value }, classes)
      const before = await page.evaluate(() => layoutMetrics())
      await page.addStyleTag({content: css})
      const after = await page.evaluate(() => layoutMetrics())
      assert.deepEqual(after, before, `Other layouts must remain unchanged: ${classes}`)
    }
    // Removing the option restores the old layout rather than moving React nodes.
    await page.setContent(fixture.replace('__CENTERED_HOME_CSS__', ''))
    assert.ok((await page.evaluate(() => layoutMetrics())).centerError > 100)
  } finally {
    await browser.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
