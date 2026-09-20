/**
 * Adds a download button to tweets with a video or a GIF in them, and to the
 * media viewer. Clicking it asks the background script to fetch and save the
 * media using the bundled cobalt engine.
 *
 * This runs in the page, alongside script.js, and talks to the extension via
 * content.js.
 */
void function() {

const BUTTON_CLASS = 'cpft-cobalt-download'
const STATUS_CLASS = 'cpft-cobalt-status'

/** Buttons which only appear in a tweet's action bar. */
const ACTION_BAR_BUTTON_SELECTOR = [
  'reply', 'retweet', 'unretweet', 'like', 'unlike', 'bookmark', 'removeBookmark',
].map((testId) => `[data-testid="${testId}"]`).join(', ')

/** Download icon, drawn on Twitter's 24x24 icon grid. */
const DOWNLOAD_ICON = 'M12 2.75a1 1 0 0 1 1 1v7.84l2.54-2.55a1 1 0 1 1 1.42 1.42l-4.25 4.25a1 1 0 0 1-1.42 0L7.04 10.46a1 1 0 1 1 1.42-1.42L11 11.59V3.75a1 1 0 0 1 1-1zM4.5 15.25a1 1 0 0 1 1 1v2.5h13v-2.5a1 1 0 1 1 2 0v3.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-3.5a1 1 0 0 1 1-1z'
/** Shown while media is being fetched or converted. */
const SPINNER_ICON = 'M12 3.5a8.5 8.5 0 1 0 8.5 8.5 1 1 0 1 1 2 0c0 5.8-4.7 10.5-10.5 10.5S1.5 17.8 1.5 12 6.2 1.5 12 1.5a1 1 0 1 1 0 2z'
/** Shown briefly after a download starts. */
const DONE_ICON = 'M9.8 17.3 4.5 12l1.4-1.4 3.9 3.9 8.3-8.3L19.5 7.6 9.8 17.3z'
/** Shown when something went wrong. */
const ERROR_ICON = 'M12 1.5C6.2 1.5 1.5 6.2 1.5 12S6.2 22.5 12 22.5 22.5 17.8 22.5 12 17.8 1.5 12 1.5zm-1 5h2v7h-2v-7zm0 9h2v2h-2v-2z'

const ERROR_MESSAGES = {
  age: 'This post is age-restricted - log in to download it',
  private: 'This post is from a protected account',
  unavailable: 'This post is unavailable',
  empty: 'No video or GIF found in this post',
  noVideo: 'No video or GIF found in this post',
  fetchFailed: "Couldn't reach the Twitter API",
  downloadFailed: "Couldn't save the file",
  badInstanceUrl: 'The cobalt instance URL in the options is not a valid URL',
  instanceUnreachable: "Couldn't reach your cobalt instance",
  instanceBadResponse: 'Your cobalt instance returned an unexpected response',
}

const config = {
  enabled: true,
  cobaltDownloadButton: true,
}

/** Pending download requests, keyed by request id. */
const pendingRequests = new Map()

/** @type {MutationObserver} */
let observer
let observerScheduled = false

//#region Utility functions
function log(...args) {
  console.log('%c[CPFT cobalt]', 'color: #1d9bf0; font-weight: bold', ...args)
}

function getErrorMessage(error, detail) {
  return ERROR_MESSAGES[error] || detail || `Download failed (${error})`
}

/** @param {string} pathname */
function getMediaIndexFromPath(pathname) {
  let match = /\/(?:photo|video)\/(\d+)\/?$/.exec(pathname)
  return match ? Number(match[1]) - 1 : undefined
}

/** @param {string} pathname */
function getTweetIdFromPath(pathname) {
  return /\/status\/(\d+)/.exec(pathname)?.[1]
}

/**
 * Tweets in timelines link to themselves from their timestamp; the focused
 * tweet on a permalink page doesn't, so its id comes from the URL.
 * @param {HTMLElement} $tweet
 */
function getTweetId($tweet) {
  let $timestampLink = $tweet?.querySelector('time')?.closest('a')
  let id = $timestampLink && getTweetIdFromPath(new URL($timestampLink.href).pathname)
  return id ?? getTweetIdFromPath(location.pathname)
}

/** @param {Element} $el */
function hasVideo($el) {
  return Boolean($el?.querySelector(
    'video, [data-testid="videoPlayer"], [data-testid="videoComponent"], [data-testid="playButton"]'
  ))
}
//#endregion

//#region Messaging
/**
 * @param {{tweetId: string, index?: number}} payload
 * @param {(update: any) => void} onProgress
 */
function requestDownload(payload, onProgress) {
  return new Promise((resolve) => {
    let requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    pendingRequests.set(requestId, {resolve, onProgress})
    window.postMessage({
      type: 'cpftCobaltDownload',
      requestId,
      tweetUrl: `${location.origin}/i/status/${payload.tweetId}`,
      ...payload,
    }, location.origin)
  })
}

window.addEventListener('message', (e) => {
  if (e.source !== window) return

  let request = pendingRequests.get(e.data?.requestId)
  if (!request) return

  if (e.data.type == 'cpftCobaltProgress') {
    request.onProgress?.(e.data.update)
  }
  else if (e.data.type == 'cpftCobaltResult') {
    pendingRequests.delete(e.data.requestId)
    request.resolve(e.data.result)
  }
})
//#endregion

//#region Button
/** @param {HTMLElement} $button */
function setIcon($button, path) {
  let $path = $button.querySelector('svg path')
  if ($path) $path.setAttribute('d', path)
}

/** @param {HTMLElement} $button */
function setStatus($button, text) {
  let $status = $button.querySelector(`.${STATUS_CLASS}`)
  if ($status) $status.textContent = text ?? ''
}

/**
 * @param {HTMLElement} $button
 * @param {'idle' | 'working' | 'done' | 'error'} state
 * @param {{label?: string, status?: string}} [options]
 */
function setState($button, state, {label, status} = {}) {
  $button.dataset.cpftState = state
  $button.classList.toggle('cpft-cobalt-working', state == 'working')
  $button.classList.toggle('cpft-cobalt-error', state == 'error')
  $button.classList.toggle('cpft-cobalt-done', state == 'done')
  setIcon($button, {
    idle: DOWNLOAD_ICON,
    working: SPINNER_ICON,
    done: DONE_ICON,
    error: ERROR_ICON,
  }[state])
  setStatus($button, status)
  if (label) {
    $button.title = label
    let $clickable = $button.querySelector('[role="button"], button') ?? $button
    $clickable.setAttribute('aria-label', label)
  }
}

/** @param {MouseEvent} e */
async function onDownloadClick(e) {
  e.preventDefault()
  e.stopPropagation()

  let $button = /** @type {HTMLElement} */ (e.currentTarget)
  if ($button.dataset.cpftState == 'working') return

  let tweetId = $button.dataset.cpftTweetId
  if (!tweetId) {
    setState($button, 'error', {label: "Couldn't work out which post this is"})
    return
  }

  let index = $button.dataset.cpftIndex ? Number($button.dataset.cpftIndex) : undefined

  setState($button, 'working', {label: 'Getting media…'})

  let result = await requestDownload({tweetId, index}, (update) => {
    if (update?.stage == 'converting') {
      let percent = Math.round((update.progress ?? 0) * 100)
      setState($button, 'working', {
        label: `Converting to GIF (${percent}%)`,
        status: `${percent}%`,
      })
    } else if (update?.stage == 'saving') {
      setState($button, 'working', {label: 'Saving…', status: ''})
    }
  })

  if (result?.downloaded) {
    setState($button, 'done', {
      label: result.downloaded > 1 ? `Saved ${result.downloaded} files` : 'Saved',
      status: '',
    })
    setTimeout(() => {
      if ($button.isConnected && $button.dataset.cpftState == 'done') {
        setState($button, 'idle', {label: 'Download', status: ''})
      }
    }, 3000)
  } else {
    let message = getErrorMessage(result?.error, result?.detail)
    log('download failed:', result)
    setState($button, 'error', {label: message, status: ''})
    setTimeout(() => {
      if ($button.isConnected && $button.dataset.cpftState == 'error') {
        setState($button, 'idle', {label: 'Download', status: ''})
      }
    }, 5000)
  }
}

/**
 * Walks up from `$el` to the element which is a direct child of `$ancestor`.
 * @param {Element} $ancestor
 * @param {Element} $el
 */
function getChildOf($ancestor, $el) {
  let $node = $el
  while ($node && $node.parentElement != $ancestor) {
    $node = $node.parentElement
  }
  return $node
}

/**
 * Builds the button by cloning one of Twitter's own action buttons, so it
 * always matches the current styling, then swapping its icon out.
 * @param {HTMLElement} $actionBar
 */
function createButton($actionBar) {
  let $templateButton = $actionBar.querySelector(
    '[data-testid="bookmark"], [data-testid="removeBookmark"], [data-testid="reply"], button[data-testid]'
  )
  let $template = /** @type {HTMLElement} */ (
    $templateButton && getChildOf($actionBar, $templateButton)
  )

  if (!$template || !$template.querySelector('svg path')) return

  let $button = /** @type {HTMLElement} */ ($template.cloneNode(true))
  $button.classList.add(BUTTON_CLASS)
  $button.removeAttribute('style')

  // Strip anything which would make Twitter treat this as one of its own
  // buttons, or navigate when it's clicked
  for (let $el of [$button, ...$button.querySelectorAll('*')]) {
    $el.removeAttribute('data-testid')
    $el.removeAttribute('href')
    $el.removeAttribute('id')
    if ($el.tagName == 'A') $el.removeAttribute('role')
  }

  // Remove metric counts and any other text the template came with
  for (let $span of $button.querySelectorAll('span')) {
    if (!$span.querySelector('svg')) $span.textContent = ''
  }

  let $svg = $button.querySelector('svg')
  $svg.innerHTML = `<g><path d="${DOWNLOAD_ICON}"></path></g>`

  let $status = document.createElement('span')
  $status.className = STATUS_CLASS
  $button.appendChild($status)

  $button.addEventListener('click', onDownloadClick, true)
  $button.title = 'Download'

  return $button
}

/**
 * @param {HTMLElement} $actionBar
 * @param {{tweetId: string, index?: number, isGif?: boolean}} details
 */
function addButton($actionBar, {tweetId, index}) {
  let $existing = /** @type {HTMLElement} */ ($actionBar.querySelector(`.${BUTTON_CLASS}`))
  if ($existing) {
    $existing.dataset.cpftTweetId = tweetId
    if (index != null) {
      $existing.dataset.cpftIndex = String(index)
    } else {
      delete $existing.dataset.cpftIndex
    }
    return
  }

  let $button = createButton($actionBar)
  if (!$button) return

  $button.dataset.cpftTweetId = tweetId
  if (index != null) $button.dataset.cpftIndex = String(index)
  setState($button, 'idle', {label: 'Download'})
  $actionBar.appendChild($button)
}

function removeButtons() {
  for (let $button of document.querySelectorAll(`.${BUTTON_CLASS}`)) {
    $button.remove()
  }
}
//#endregion

//#region Page processing
function processPage() {
  if (!config.enabled || !config.cobaltDownloadButton) return

  for (let $actionBar of document.querySelectorAll('[role="group"]')) {
    // role="group" is used in other places, e.g. around the tweet box, so only
    // take action bars which have tweet actions in them
    if (!$actionBar.querySelector(ACTION_BAR_BUTTON_SELECTOR)) continue

    let $tweet = /** @type {HTMLElement} */ ($actionBar.closest('article'))
    let $modal = /** @type {HTMLElement} */ ($actionBar.closest('[aria-modal="true"]'))
    let inMediaViewer = Boolean($modal) || document.body.classList.contains('MediaViewer') ||
                        document.body.classList.contains('MobileMedia')

    // In the media viewer the video is outside the tweet the action bar is in
    let hasMedia = hasVideo($tweet) || (inMediaViewer && hasVideo($modal ?? document.body))
    if (!hasMedia) continue

    let tweetId = getTweetId($tweet)
    if (!tweetId) continue

    addButton(/** @type {HTMLElement} */ ($actionBar), {
      tweetId,
      index: inMediaViewer ? getMediaIndexFromPath(location.pathname) : undefined,
    })
  }
}

function scheduleProcessPage() {
  if (observerScheduled) return
  observerScheduled = true
  requestAnimationFrame(() => {
    observerScheduled = false
    try {
      processPage()
    } catch (e) {
      log('error adding download buttons', e)
    }
  })
}

function startObserving() {
  if (observer) return
  observer = new MutationObserver(scheduleProcessPage)
  observer.observe(document.body, {childList: true, subtree: true})
  scheduleProcessPage()
}

function stopObserving() {
  observer?.disconnect()
  observer = null
  removeButtons()
}

function onConfigChange() {
  if (config.enabled && config.cobaltDownloadButton) {
    startObserving()
  } else {
    stopObserving()
  }
}
//#endregion

//#region Styles
function addStyle() {
  let $style = document.createElement('style')
  $style.dataset.cpftCobalt = 'true'
  $style.textContent = `
.${BUTTON_CLASS} {
  cursor: pointer;
}
.${BUTTON_CLASS} svg {
  transition: transform .2s ease;
}
.${BUTTON_CLASS}.cpft-cobalt-working svg {
  animation: cpft-cobalt-spin .8s linear infinite;
}
.${BUTTON_CLASS}.cpft-cobalt-error svg {
  color: rgb(244, 33, 46);
  fill: rgb(244, 33, 46);
}
.${BUTTON_CLASS}.cpft-cobalt-done svg {
  color: rgb(0, 186, 124);
  fill: rgb(0, 186, 124);
}
.${STATUS_CLASS} {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  margin-inline-start: 4px;
}
@keyframes cpft-cobalt-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
`
  document.documentElement.appendChild($style)
}
//#endregion

//#region Main
let $settings = /** @type {HTMLScriptElement} */ (document.querySelector('script#cpftSettings'))
if ($settings) {
  try {
    Object.assign(config, JSON.parse($settings.innerText))
  } catch {}

  new MutationObserver(() => {
    try {
      let changes = JSON.parse($settings.innerText)
      if ('enabled' in changes || 'cobaltDownloadButton' in changes) {
        Object.assign(config, changes)
        onConfigChange()
      }
    } catch {}
  }).observe($settings, {childList: true})
}

addStyle()
onConfigChange()
//#endregion

}()
