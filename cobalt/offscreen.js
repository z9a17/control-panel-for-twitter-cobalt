/**
 * Runs GIF conversion for the MV3 service worker, which has no DOM of its own.
 */

import {convertToGif} from './gif.js'

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type == 'cpftCobaltRevokeBlobUrl') {
    URL.revokeObjectURL(message.url)
    return
  }

  if (message?.type != 'cpftCobaltConvertGif') return

  convertToGif(message.url, {
    onProgress(progress) {
      chrome.runtime.sendMessage({
        type: 'cpftCobaltGifProgress',
        url: message.url,
        progress,
      }).catch(() => {})
    },
  }).then(
    (blob) => sendResponse({blobUrl: URL.createObjectURL(blob)}),
    (e) => sendResponse({error: e.message})
  )

  return true
})
