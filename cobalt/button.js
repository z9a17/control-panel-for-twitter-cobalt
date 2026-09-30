/**
 * Adds a media download item to the share dropdown. Clicking it asks the background script to fetch and save the
 * media using the bundled cobalt engine.
 *
 * This runs in the page, alongside script.js, and talks to the extension via
 * content.js.
 */
void function() {

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
  cobaltShareMenuItem: true,
  hideSharePostVia: false,
}

/** Config options this script reacts to. */
const CONFIG_KEYS = ['enabled', 'cobaltShareMenuItem', 'hideSharePostVia']

/** Pending download requests, keyed by request id. */
const pendingRequests = new Map()

/** @type {MutationObserver} */
let observer

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

function getChildOf($ancestor, $el) {
  let $node = $el
  while ($node && $node.parentElement != $ancestor) $node = $node.parentElement
  return $node
}

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
    // Include photos alongside videos and GIFs
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
  if (!$clicked) return
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
  if (!config.enabled || !shareMenuContext || Date.now() - shareMenuContext.time > SHARE_MENU_TIMEOUT) return

  for (let $menu of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(MENU_SELECTOR))) {
    if ($menu.dataset.cpftCobaltMenu) continue

    let $items = /** @type {NodeListOf<HTMLElement>} */ ($menu.querySelectorAll('[role="menuitem"]'))
    if ($items.length == 0 || $menu.querySelector(RETWEET_MENU_SELECTOR)) continue

    if (config.hideSharePostVia) {
      let $sharePostVia = findSharePostViaItem($items)
      if ($sharePostVia) $sharePostVia.style.display = 'none'
    }
    if (config.cobaltShareMenuItem) {
      addDownloadMenuItem($items, shareMenuContext)
      if (!$menu.querySelector(`.${MENU_ITEM_CLASS}`) && shareMenuContext.kind) continue
    }
    $menu.dataset.cpftCobaltMenu = 'true'
  }
}

function removeMenuItems() {
  for (let $menuItem of document.querySelectorAll(`.${MENU_ITEM_CLASS}`)) {
    $menuItem.remove()
  }
}
//#endregion

//#region Page processing
function startObserving() {
  if (observer) return
  observer = new MutationObserver(processShareMenu)
  observer.observe(document.body, {childList: true, subtree: true})
  processShareMenu()
}

function stopObserving() {
  observer?.disconnect()
  observer = null
  removeMenuItems()
}

function onConfigChange() {
  if (!config.enabled || !config.cobaltShareMenuItem) removeMenuItems()

  if (config.enabled && (config.cobaltShareMenuItem || config.hideSharePostVia)) {
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
