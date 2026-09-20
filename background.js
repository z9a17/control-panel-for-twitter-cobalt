import {downloadTweetMedia} from './cobalt/download.js'

const isSafari = location.protocol.startsWith('safari-web-extension:')

const enabledIcons = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  64: 'icons/icon64.png',
  96: 'icons/icon96.png',
  128: 'icons/icon128.png',
}

const disabledIcons = {
  16: 'icons/icon16-disabled.png',
  32: 'icons/icon32-disabled.png',
  48: 'icons/icon48-disabled.png',
  64: 'icons/icon64-disabled.png',
  96: 'icons/icon96-disabled.png',
  128: 'icons/icon128-disabled.png',
}

function updateToolbarIcon(enabled) {
  let title = chrome.i18n.getMessage(enabled ? 'extensionName' : 'extensionNameDisabled')
  if (chrome.runtime.getManifest().manifest_version == 3) {
    chrome.action.setTitle({title})
    if (!isSafari) {
      chrome.action.setIcon({path: enabled ? enabledIcons : disabledIcons})
    } else {
      chrome.action.setBadgeText({text: enabled ? '' : '⏻'})
    }
  } else {
    chrome.browserAction.setTitle({title})
    chrome.browserAction.setIcon({path: enabled ? enabledIcons : disabledIcons})
  }
}

// Update browser action icon to reflect enabled state
chrome.storage.local.get({enabled: true}, ({enabled}) => {
  updateToolbarIcon(enabled)
})

chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.enabled) {
    updateToolbarIcon(changes.enabled.newValue)
  }
})

// Handle download requests from the cobalt download button
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type != 'cpftCobaltDownload') return

  let tabId = sender.tab?.id

  downloadTweetMedia(message, (update) => {
    if (tabId == null) return
    chrome.tabs.sendMessage(tabId, {
      type: 'cpftCobaltProgress',
      requestId: message.requestId,
      update,
    }).catch(() => {})
  }).then(
    sendResponse,
    (e) => sendResponse({error: 'downloadFailed', detail: e.message})
  )

  return true
})