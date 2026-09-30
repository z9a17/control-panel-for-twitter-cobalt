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
  const svgStart = source.indexOf('const Svgs =')
  const svgSource = source.slice(svgStart, source.indexOf('\n}', svgStart) + 2)
  const css = vm.runInNewContext(svgSource + '\n' + source.slice(start, source.indexOf('\n//#region CSS', start)) + ';getCenteredHomeTimelineCss()', {config: {replaceLogo: true}})
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'home-layout.html'), 'utf8')
  const browser = await chromium.launch({headless: true, args: ['--disable-gpu']})
  try {
    const page = await browser.newPage()
    for (const route of ['Profile', 'Notifications', 'HomeTimeline', 'Tweet']) {
      for (const width of [2560, 1920, 1600, 1440, 1280, 1264, 1203, 1143, 1024, 1000, 999, 800, 700, 600]) {
        if (route === 'Profile' && width > 1264) continue
        await page.setViewportSize({width, height: 800})
        await page.setContent(fixture.replace('__CENTERED_HOME_CSS__', css))
        await page.evaluate(route => {
          document.body.className = `Desktop ${route} Sidebar`
          if (route === 'Tweet') {
            document.querySelector('.tabs').innerHTML = '<button aria-label="Back">←</button><strong>Tweet</strong>'
          } else if (route === 'Profile') {
            document.querySelector('.tabs').innerHTML = '<button aria-label="Back">←</button><strong>Example profile</strong>'
            const profile = document.querySelector('article')
            profile.style.padding = '0'
            profile.innerHTML = '<div class="profile-banner" style="width:100%;aspect-ratio:3/1;background:#8598aa"></div><div style="padding:16px"><div style="display:flex;justify-content:space-between;align-items:center"><div class="avatar" style="width:112px;height:112px"></div><button aria-label="Following">Following</button></div><h2>Example profile</h2><p>@example</p><p>Profile description with links and follower counts.</p></div>'
          } else if (route === 'Notifications') {
            const header = document.querySelector('.tabs')
            header.style.cssText = 'height:106px;display:block'
            header.innerHTML = '<div style="height:50px;padding:16px"><strong>Notifications</strong></div><nav aria-label="Notifications" style="height:56px;display:flex;justify-content:space-around;align-items:center"><button role="tab" aria-selected="true">All</button><button role="tab" aria-selected="false">Mentions</button></nav>'
          }
        }, route)
        await page.evaluate(() => window.scrollTo(0, 0))
        const metrics = await page.evaluate(() => layoutMetrics())
        assert.ok(metrics.centerError < 1, `Feed must be centered at ${width}px: ${JSON.stringify(metrics)}`)
        assert.equal(metrics.feedTop, 0, 'Sidebar must not reserve space above the posts')
        if (width >= 1000) {
          assert.ok(metrics.search.x >= metrics.feed.x + metrics.feed.width + 12, `Search must stay to the right of centered posts: ${JSON.stringify(metrics)}`)
          assert.ok(metrics.search.x + metrics.search.width <= width - 8, 'Search must fit within the viewport')
          assert.ok(metrics.search.width >= 160 && metrics.search.width <= 350, 'Search must fit the available right margin')
        } else {
          assert.equal(metrics.search.width, 0, 'Hide the sidebar when the right margin cannot fit search')
        }
        assert.ok(metrics.navFits, `Compose and account buttons must fit beside the feed: ${JSON.stringify(metrics)}`)
        assert.equal(metrics.composeWidth, 49, 'Compose button must stay compact at the wide-screen breakpoint')
        assert.equal(metrics.accountWidth, 49, 'Account switcher must stay compact at the wide-screen breakpoint')
        const composeIcon = await page.locator('#compose').evaluate(element => {
          const icon = getComputedStyle(element, '::before')
          return {content: icon.content, width: icon.width, mask: icon.maskImage}
        })
        assert.equal(composeIcon.content, '""', 'Compose icon must be rendered even when X supplies only text')
        assert.equal(composeIcon.width, '24px')
        assert.ok(composeIcon.mask.startsWith('url("data:image/svg+xml,'), 'Compose icon must have an SVG mask')
        assert.equal(metrics.overflow, false, `No horizontal overflow at ${width}px`)
        if (route === 'Profile') {
          const banner = await page.locator('.profile-banner').boundingBox()
          assert.ok(banner.width <= metrics.feed.width, 'Profile banner must fit the centered column')
          const following = await page.getByRole('button', {name: 'Following', exact: true}).boundingBox()
          assert.ok(following && following.x >= metrics.feed.x && following.x + following.width <= metrics.feed.x + metrics.feed.width, 'Profile actions must remain visible inside the column')
        }
        if (width >= 1000) {
          await page.getByRole('textbox', {name: 'Search query'}).fill('test query')
          assert.equal(await page.getByRole('textbox', {name: 'Search query'}).inputValue(), 'test query')
          // A sidebar appearing or disappearing must not move the posts.
          await page.locator('#sidebar').evaluate(element => { element.style.setProperty('display', 'none', 'important') })
          assert.deepEqual((await page.evaluate(() => layoutMetrics())).feed, metrics.feed)
          await page.locator('#sidebar').evaluate(element => { element.style.removeProperty('display') })
        }
        await page.evaluate(() => window.scrollTo(0, 250))
        const tabs = await page.locator('.tabs').boundingBox()
        assert.ok(Math.abs(tabs.y) < 1, 'Timeline tabs must remain sticky')
        if (width >= 1000) {
          const search = await page.getByRole('textbox', {name: 'Search query'}).boundingBox()
          assert.ok(search.y >= 0 && search.y < 50, 'Right-side search must remain visible when scrolling')
        }
        console.log(`PASS: ${route} at ${width}px, centered posts, right-side search when space permits, compact navigation and sticky header`)
      }
    }
    // Client-side navigation must keep the same column and navigation positions.
    await page.setViewportSize({width: 1143, height: 800})
    await page.setContent(fixture.replace('__CENTERED_HOME_CSS__', css))
    const homeMetrics = await page.evaluate(() => layoutMetrics())
    for (const route of ['Tweet', 'Notifications', 'Profile', 'HomeTimeline']) {
      await page.evaluate(route => { document.body.className = `Desktop ${route} Sidebar` }, route)
      assert.deepEqual(await page.evaluate(() => layoutMetrics()), homeMetrics, `Navigating to ${route} must not move the columns`)
    }
    // CSS must leave mobile and unrelated desktop layouts alone.
    for (const classes of ['Mobile HomeTimeline Sidebar', 'Mobile Tweet Sidebar', 'Mobile Notifications Sidebar', 'Mobile Profile Sidebar', 'Desktop Search Sidebar']) {
      await page.setViewportSize({width: 1203, height: 800})
      await page.setContent(fixture.replace('__CENTERED_HOME_CSS__', ''))
      await page.evaluate(value => { document.body.className = value }, classes)
      const before = await page.evaluate(() => layoutMetrics())
      await page.addStyleTag({content: css})
      const after = await page.evaluate(() => layoutMetrics())
      assert.deepEqual(after, before, `Other layouts must remain unchanged: ${classes}`)
    }
    // Keep the existing profile layout on larger displays.
    for (const width of [1265, 1280, 1440, 1600, 1920, 2560]) {
      await page.setViewportSize({width, height: 800})
      await page.setContent(fixture.replace('__CENTERED_HOME_CSS__', ''))
      await page.evaluate(() => { document.body.className = 'Desktop Profile Sidebar' })
      const before = await page.evaluate(() => layoutMetrics())
      await page.addStyleTag({content: css})
      assert.deepEqual(await page.evaluate(() => layoutMetrics()), before, `Wide profile layout must remain unchanged at ${width}px`)
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
