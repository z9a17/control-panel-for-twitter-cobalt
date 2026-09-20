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
const MENU_ITEM_CLASS = 'cpft-cobalt-menu-item'
const TOAST_CLASS = 'cpft-cobalt-toast'

/** Buttons which only appear in a tweet's action bar. */
const ACTION_BAR_BUTTON_SELECTOR = [
  'reply', 'retweet', 'unretweet', 'like', 'unlike', 'bookmark', 'removeBookmark',
].map((testId) => `[data-testid="${testId}"]`).join(', ')

/** Everything in an action bar which isn't the share button. */
const NON_SHARE_BUTTON_SELECTOR = `${ACTION_BAR_BUTTON_SELECTOR}, a[href$="/analytics"]`

/** Dropdown menus - the first is used on desktop, the second on mobile. */
const MENU_SELECTOR = '[data-testid="Dropdown"], [data-testid="sheetDialog"]'

/** The retweet menu is the only other menu which opens from the action bar. */
const RETWEET_MENU_SELECTOR = '[data-testid$="etweetConfirm"], [data-testid$="epostConfirm"]'

/** Menus which appear later than this after a share button was clicked aren't its menu. */
const SHARE_MENU_TIMEOUT = 5000

/** Share menu item labels, by what the tweet has in it. */
const MENU_ITEM_LABELS = {
  video: 'Download video',
  gif: 'Download GIF',
  photo: 'Download image',
  photos: 'Download images',
}

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
  noMedia: 'No media found in this post',
  fetchFailed: "Couldn't reach the Twitter API",
  downloadFailed: "Couldn't save the file",
  badInstanceUrl: 'The cobalt instance URL in the options is not a valid URL',
  instanceUnreachable: "Couldn't reach your cobalt instance",
  instanceBadResponse: 'Your cobalt instance returned an unexpected response',
}

const config = {
  enabled: true,
  cobaltDownloadButton: true,
  cobaltShareMenuItem: true,
  hideSharePostVia: false,
}

/** Config options this script reacts to. */
const CONFIG_KEYS = ['enabled', 'cobaltDownloadButton', 'cobaltShareMenuItem', 'hideSharePostVia']

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

/**
 * role="group" is used for other things - the media viewer's carousel wraps
 * the tweet it's showing, so it contains action buttons too - so only take
 * groups whose own children are the tweet's action buttons.
 * @param {Element} $group
 */
function isActionBar($group) {
  let $button = $group.querySelector(ACTION_BAR_BUTTON_SELECTOR)
  return Boolean($button) && $button.closest('[role="group"]') == $group
}

/** @param {Element} $el */
function hasVideo($el) {
  return Boolean($el?.querySelector(
    'video, [data-testid="videoPlayer"], [data-testid="videoComponent"], [data-testid="playButton"]'
  ))
}

/**
 * What kind of media is in the given part of the page, if any.
 * @param {Element} $el
 * @returns {'video' | 'gif' | 'photo' | null}
 */
function getMediaKind($el) {
  if (!$el) return null
  if (hasVideo($el)) {
    return $el.querySelector('[aria-label="GIF"], [data-testid="gifPlayer"]') ? 'gif' : 'video'
  }
  if ($el.querySelector('[data-testid="tweetPhoto"], a[href*="/photo/"] img, img[src*="/media/"]')) {
    return 'photo'
  }
  return null
}

/** @param {Element} $el */
function countPhotos($el) {
  return $el?.querySelectorAll('[data-testid="tweetPhoto"]').length ?? 0
}

/**
 * Works out which tweet an action bar belongs to and what media it has.
 * @param {HTMLElement} $actionBar
 */
function getMediaDetails($actionBar) {
  let $tweet = /** @type {HTMLElement} */ ($actionBar.closest('article'))
  let $modal = /** @type {HTMLElement} */ ($actionBar.closest('[aria-modal="true"]'))
  let inMediaViewer = Boolean($modal) || document.body.classList.contains('MediaViewer') ||
                      document.body.classList.contains('MobileMedia')
  // In the media viewer the media is outside the tweet the action bar is in
  let $media = (inMediaViewer ? $modal ?? document.body : $tweet) ?? document.body
  return {
    tweetId: getTweetId($tweet),
    index: inMediaViewer ? getMediaIndexFromPath(location.pathname) : undefined,
    kind: getMediaKind($media),
    photoCount: countPhotos($media),
  }
}
//#endregion

//#region Messaging
/**
 * @param {{tweetId: string, index?: number, photos?: boolean}} payload
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

//#region Share menu
/** Details of the last share button clicked, used when its menu turns up. */
let shareMenuContext = null

/** @type {HTMLElement} */
let $toast
let toastTimeout

/**
 * Shows a message at the bottom of the screen, as downloads started from the
 * share menu have no button to show their progress on.
 * @param {string} text
 */
function showToast(text) {
  if (!$toast?.isConnected) {
    $toast = document.createElement('div')
    $toast.className = TOAST_CLASS
    document.body.appendChild($toast)
  }

  let update = (/** @type {string} */ text, /** @type {boolean} */ error = false) => {
    clearTimeout(toastTimeout)
    $toast.textContent = text
    $toast.classList.toggle('cpft-cobalt-error', Boolean(error))
  }

  update(text)

  return {
    update,
    done(/** @type {string} */ text, /** @type {boolean} */ error = false) {
      update(text, error)
      let $done = $toast
      toastTimeout = setTimeout(() => $done.remove(), error ? 6000 : 3000)
    },
  }
}

/**
 * Menus are rendered with an invisible layer in front of the page which
 * dismisses them when it's clicked.
 * @param {HTMLElement} $menuItem
 */
function closeMenu($menuItem) {
  let $menuLayer = $menuItem.closest('[role="group"]')?.firstElementChild?.firstElementChild
  if ($menuLayer instanceof HTMLElement) {
    $menuLayer.click()
    return
  }
  let $mask = /** @type {HTMLElement} */ (document.querySelector('[data-testid="mask"]'))
  if ($mask) {
    $mask.click()
    return
  }
  document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))
}

/**
 * @param {{kind: string, index?: number, photoCount: number}} context
 * @param {NodeListOf<HTMLElement>} $items
 */
function getMenuItemLabel({kind, index, photoCount}, $items) {
  let label = kind == 'photo' && index == null && photoCount > 1
    ? MENU_ITEM_LABELS.photos
    : MENU_ITEM_LABELS[kind]
  if (!label) return label
  // Twitter has its own download item for some videos - tell them apart
  for (let $item of $items) {
    if ($item.textContent.trim() == label) return `${label} (cobalt)`
  }
  return label
}

/**
 * Finds the "Share post via …" item, which uses the same icon as the share
 * button the menu was opened from.
 * @param {NodeListOf<HTMLElement>} $items
 */
function findSharePostViaItem($items) {
  let iconPath = shareMenuContext?.iconPath
  if (iconPath) {
    for (let $item of $items) {
      for (let $path of $item.querySelectorAll('svg path')) {
        if ($path.getAttribute('d') == iconPath) return $item
      }
    }
  }
  // Failing that, it's the only item whose label trails off into an ellipsis
  for (let $item of $items) {
    if (/(…|\.\.\.)$/.test($item.textContent.trim())) return $item
  }
}

/** @param {{tweetId: string, index?: number, kind: string, photoCount: number}} context */
async function downloadFromMenu(context) {
  let toast = showToast('Getting media…')

  let result = await requestDownload({
    tweetId: context.tweetId,
    index: context.index,
    // Photos are only downloaded from the share menu, not the download button
    photos: true,
  }, (update) => {
    if (update?.stage == 'converting') {
      toast.update(`Converting to GIF (${Math.round((update.progress ?? 0) * 100)}%)`)
    } else if (update?.stage == 'saving') {
      toast.update('Saving…')
    }
  })

  if (result?.downloaded) {
    toast.done(result.downloaded > 1 ? `Saved ${result.downloaded} files` : 'Saved')
  } else {
    log('download failed:', result)
    toast.done(getErrorMessage(result?.error, result?.detail), true)
  }
}

/**
 * Adds a download item to the share menu by cloning one of its own items.
 * @param {NodeListOf<HTMLElement>} $items
 * @param {{tweetId: string, index?: number, kind: string, photoCount: number}} context
 */
function addDownloadMenuItem($items, context) {
  let label = getMenuItemLabel(context, $items)
  if (!context.tweetId || !label) return

  let $template = /** @type {HTMLElement} */ (
    Array.from($items).find(($item) =>
      $item.style.display != 'none' && $item.querySelector('svg') && $item.querySelector('[dir]')
    )
  )
  if (!$template) return

  let $menuItem = /** @type {HTMLElement} */ ($template.cloneNode(true))
  $menuItem.classList.add(MENU_ITEM_CLASS)
  $menuItem.style.display = ''

  // Strip anything which would make Twitter treat this as one of its own items
  for (let $el of [$menuItem, ...$menuItem.querySelectorAll('*')]) {
    $el.removeAttribute('data-testid')
    $el.removeAttribute('href')
    $el.removeAttribute('id')
  }

  $menuItem.querySelector('svg').innerHTML = `<g><path d="${DOWNLOAD_ICON}"></path></g>`

  let $label = $menuItem.querySelector('[dir] span') ?? $menuItem.querySelector('[dir]')
  if ($label) $label.textContent = label

  $menuItem.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    closeMenu($menuItem)
    downloadFromMenu(context)
  }, true)

  $template.parentElement.appendChild($menuItem)
}

/**
 * Twitter's share menu has nothing identifying in it, so the share button
 * click which opened it is used as the cue instead.
 */
document.addEventListener('click', (e) => {
  if (!config.enabled || (!config.cobaltShareMenuItem && !config.hideSharePostVia)) return

  // Any other click means the next menu to appear isn't a share menu
  shareMenuContext = null

  let $el = e.target instanceof Element ? e.target : null
  let $actionBar = /** @type {HTMLElement} */ ($el?.closest('[role="group"]'))
  if (!$actionBar || !isActionBar($actionBar)) return

  let $clicked = getChildOf($actionBar, $el)
  if (!$clicked || $clicked.classList.contains(BUTTON_CLASS)) return
  // Twitter's own buttons either don't open a menu, or open one of their own
  if ($clicked.matches(NON_SHARE_BUTTON_SELECTOR) ||
      $clicked.querySelector(NON_SHARE_BUTTON_SELECTOR)) return

  shareMenuContext = {
    ...getMediaDetails($actionBar),
    iconPath: $clicked.querySelector('svg path')?.getAttribute('d'),
    time: Date.now(),
  }
}, true)

function processShareMenu() {
  if (!shareMenuContext || Date.now() - shareMenuContext.time > SHARE_MENU_TIMEOUT) return

  for (let $menu of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(MENU_SELECTOR))) {
    if ($menu.dataset.cpftCobaltMenu) continue

    let $items = /** @type {NodeListOf<HTMLElement>} */ ($menu.querySelectorAll('[role="menuitem"]'))
    if ($items.length == 0 || $menu.querySelector(RETWEET_MENU_SELECTOR)) continue

    $menu.dataset.cpftCobaltMenu = 'true'

    if (config.hideSharePostVia) {
      let $sharePostVia = findSharePostViaItem($items)
      if ($sharePostVia) $sharePostVia.style.display = 'none'
    }
    if (config.cobaltShareMenuItem) {
      addDownloadMenuItem($items, shareMenuContext)
    }
  }
}

function removeMenuItems() {
  for (let $menuItem of document.querySelectorAll(`.${MENU_ITEM_CLASS}`)) {
    $menuItem.remove()
  }
}
//#endregion

//#region Page processing
function processPage() {
  if (!config.enabled) return

  if (config.cobaltDownloadButton) {
    for (let $actionBar of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[role="group"]'))) {
      if (!isActionBar($actionBar)) {
        // Tidy up after anything which stopped being an action bar
        $actionBar.querySelector(`:scope > .${BUTTON_CLASS}`)?.remove()
        continue
      }

      let {tweetId, index, kind} = getMediaDetails($actionBar)
      if (!tweetId || (kind != 'video' && kind != 'gif')) {
        $actionBar.querySelector(`:scope > .${BUTTON_CLASS}`)?.remove()
        continue
      }

      addButton($actionBar, {tweetId, index})
    }
  }

  processShareMenu()
}

/**
 * Timelines mutate constantly while scrolling, so batch the work up instead of
 * looking for action bars on every mutation.
 */
function scheduleProcessPage() {
  if (observerScheduled) return
  observerScheduled = true
  setTimeout(() => {
    observerScheduled = false
    try {
      processPage()
    } catch (e) {
      log('error adding download buttons', e)
    }
  }, 150)
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
  removeMenuItems()
}

function onConfigChange() {
  if (!config.enabled || !config.cobaltDownloadButton) removeButtons()
  if (!config.enabled || !config.cobaltShareMenuItem) removeMenuItems()

  if (config.enabled && (config.cobaltDownloadButton || config.cobaltShareMenuItem || config.hideSharePostVia)) {
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
  /* Twitter's action buttons grow to fill the bar and draw their icon at the
     start of the space they take up - this one just takes the width it needs,
     at the end of the bar */
  flex: 0 0 auto !important;
  justify-content: flex-end !important;
  margin-inline-start: auto !important;
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
.${TOAST_CLASS} {
  position: fixed;
  inset-inline: 0;
  bottom: 24px;
  z-index: 10000;
  width: fit-content;
  max-width: min(90vw, 480px);
  margin-inline: auto;
  padding: 12px 16px;
  border-radius: 4px;
  background: rgb(29, 155, 240);
  color: rgb(255, 255, 255);
  font-size: 15px;
  line-height: 20px;
  text-align: center;
  box-shadow: rgba(0, 0, 0, 0.3) 0 0 8px;
}
.${TOAST_CLASS}.cpft-cobalt-error {
  background: rgb(244, 33, 46);
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
      if (CONFIG_KEYS.some((key) => key in changes)) {
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
