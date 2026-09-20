/**
 * Ties everything together for the background script: work out what media a
 * tweet has, convert Twitter GIFs to real GIFs if wanted, and save the files.
 */

import {getTweetMedia, toDownloadItems} from './engine.js'
import {getInstanceMedia} from './instance.js'

const OFFSCREEN_DOCUMENT = 'cobalt/offscreen.html'

/** @type {Promise<void>} */
let creatingOffscreenDocument

/** Default values for the options this feature adds. */
export const cobaltConfig = {
  cobaltDownloadButton: true,
  cobaltConvertGifs: true,
  cobaltIncludeAuthor: true,
  cobaltAskWhereToSave: false,
  cobaltApiInstance: '',
  cobaltApiKey: '',
}

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(cobaltConfig, resolve)
  })
}

/** The ct0 cookie doubles as the CSRF token for logged-in API requests. */
async function getCsrfToken() {
  if (!chrome.cookies) return undefined
  for (let url of ['https://x.com', 'https://twitter.com']) {
    try {
      let cookie = await chrome.cookies.get({url, name: 'ct0'})
      if (cookie?.value) return cookie.value
    } catch {}
  }
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    let contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)],
    })
    return contexts.length > 0
  }
  return false
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return
  if (creatingOffscreenDocument) return creatingOffscreenDocument

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT,
    reasons: ['BLOBS'],
    justification: 'Converting a Twitter GIF video into a GIF file',
  })

  try {
    await creatingOffscreenDocument
  } finally {
    creatingOffscreenDocument = null
  }
}

/**
 * Converts a Twitter GIF video to a GIF file and returns a blob URL for it.
 *
 * In MV3 this has to happen in an offscreen document, as service workers have
 * no DOM to decode video frames with; in MV2 the background page can do it.
 *
 * @param {string} url
 * @param {(progress: number) => void} [onProgress]
 * @returns {Promise<{blobUrl?: string, error?: string}>}
 */
async function convertToGifBlobUrl(url, onProgress) {
  if (typeof document == 'undefined') {
    await ensureOffscreenDocument()

    let onMessage = (message) => {
      if (message?.type == 'cpftCobaltGifProgress' && message.url == url) {
        onProgress?.(message.progress)
      }
    }
    chrome.runtime.onMessage.addListener(onMessage)
    try {
      return await chrome.runtime.sendMessage({type: 'cpftCobaltConvertGif', url})
    } finally {
      chrome.runtime.onMessage.removeListener(onMessage)
    }
  }

  try {
    let {convertToGif} = await import('./gif.js')
    let blob = await convertToGif(url, {onProgress})
    return {blobUrl: URL.createObjectURL(blob)}
  } catch (e) {
    return {error: e.message}
  }
}

/** @returns {Promise<number>} the download id */
function startDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      let error = chrome.runtime.lastError
      if (error || downloadId == null) {
        reject(new Error(error?.message ?? 'download failed'))
      } else {
        resolve(downloadId)
      }
    })
  })
}

/** Resolves when a download has finished, so blob URLs can be cleaned up. */
function whenDownloadFinished(downloadId) {
  return new Promise((resolve) => {
    let onChanged = (delta) => {
      if (delta.id != downloadId) return
      if (delta.state?.current == 'complete' || delta.state?.current == 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged)
        resolve(delta.state.current)
      }
    }
    chrome.downloads.onChanged.addListener(onChanged)
  })
}

/**
 * @param {{tweetId: string, index?: number, tweetUrl?: string}} request
 * @param {(update: {stage: string, progress?: number, index?: number, total?: number}) => void} [onProgress]
 * @returns {Promise<{downloaded?: number, error?: string, detail?: string}>}
 */
export async function downloadTweetMedia({tweetId, index, tweetUrl}, onProgress) {
  let config = await getConfig()

  onProgress?.({stage: 'fetching'})

  /** @type {import("../types").CobaltMediaItem[]} */
  let items = []

  if (config.cobaltApiInstance) {
    let url = tweetUrl || `https://x.com/i/status/${tweetId}`
    let result = await getInstanceMedia(config.cobaltApiInstance, url, {
      apiKey: config.cobaltApiKey,
      convertGifs: config.cobaltConvertGifs,
    })
    if (result.error) return {error: result.error}
    items = result.items ?? []
  } else {
    let {media, screenName, error} = await getTweetMedia({
      id: tweetId,
      csrfToken: await getCsrfToken(),
    })
    if (error) return {error}

    let options = {
      media,
      id: tweetId,
      screenName,
      includeAuthor: config.cobaltIncludeAuthor,
      convertGifs: config.cobaltConvertGifs,
    }
    items = toDownloadItems({...options, index})
    // The media viewer index can point at a photo in a mixed tweet, in which
    // case fall back to every video and GIF it has
    if (items.length == 0) {
      items = toDownloadItems(options)
    }
  }

  if (items.length == 0) return {error: 'noVideo'}

  let downloaded = 0
  let lastError

  for (let [i, item] of items.entries()) {
    let url = item.url
    let blobUrl

    if (item.convertToGif) {
      onProgress?.({stage: 'converting', index: i, total: items.length, progress: 0})
      let result = await convertToGifBlobUrl(url, (progress) => {
        onProgress?.({stage: 'converting', index: i, total: items.length, progress})
      })
      if (result?.blobUrl) {
        blobUrl = url = result.blobUrl
      } else {
        // Fall back to saving the original mp4 rather than failing outright
        lastError = result?.error
        item = {...item, filename: item.filename.replace(/\.gif$/, '.mp4')}
      }
    }

    onProgress?.({stage: 'saving', index: i, total: items.length})

    try {
      let downloadId = await startDownload({
        url,
        filename: item.filename,
        saveAs: Boolean(config.cobaltAskWhereToSave),
      })
      downloaded++
      if (blobUrl) {
        whenDownloadFinished(downloadId).then(() => {
          if (typeof document == 'undefined') {
            // The offscreen document owns the blob URL in MV3
            chrome.runtime.sendMessage({type: 'cpftCobaltRevokeBlobUrl', url: blobUrl}).catch(() => {})
          } else {
            URL.revokeObjectURL(blobUrl)
          }
        })
      }
    } catch (e) {
      lastError = e.message
    }
  }

  if (downloaded == 0) return {error: 'downloadFailed', detail: lastError}

  return {downloaded, detail: lastError}
}
