/**
 * Converts a Twitter "GIF" (which is really a silent mp4) into an actual GIF
 * file, which is what cobalt does with ffmpeg when `convertGif` is on.
 *
 * This runs in a document with a DOM - an offscreen document in MV3, or the
 * background page in MV2 - because it decodes frames with a <video> element.
 */

import {GIFEncoder, quantize, applyPalette} from './vendor/gifenc.js'

/** GIF frame delays are in hundredths of a second, so 25fps is exactly 4. */
const DEFAULT_FPS = 25
/** Videos longer than this aren't worth converting - the GIF would be huge. */
const MAX_DURATION_SECONDS = 60
/** Above this many pixels to encode, quality is reduced to keep GIFs sane. */
const PIXEL_BUDGET = 120_000_000
/** Longest side used when a video has to be scaled down. */
const MAX_SCALED_SIZE = 720
/** Frames sampled to build the shared colour palette. */
const PALETTE_SAMPLE_FRAMES = 6

function waitFor($el, event, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for ${event}`))
    }, timeoutMs)
    function cleanup() {
      clearTimeout(timeout)
      $el.removeEventListener(event, onEvent)
      $el.removeEventListener('error', onError)
    }
    function onEvent() {
      cleanup()
      resolve(undefined)
    }
    function onError() {
      cleanup()
      reject(new Error(`error while waiting for ${event}`))
    }
    $el.addEventListener(event, onEvent)
    $el.addEventListener('error', onError)
  })
}

/**
 * @param {string} url mp4 URL
 * @param {{onProgress?: (progress: number) => void}} [options]
 * @returns {Promise<Blob>}
 */
export async function convertToGif(url, {onProgress} = {}) {
  let response = await fetch(url, {credentials: 'omit'})
  if (!response.ok) throw new Error(`couldn't fetch video (${response.status})`)

  let objectUrl = URL.createObjectURL(await response.blob())
  let $video = document.createElement('video')
  $video.muted = true
  $video.playsInline = true
  $video.preload = 'auto'
  $video.src = objectUrl

  try {
    await waitFor($video, 'loadeddata')

    let duration = $video.duration
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('video duration is unknown')
    }
    if (duration > MAX_DURATION_SECONDS) {
      throw new Error(`video is too long to convert (${Math.round(duration)}s)`)
    }

    let width = $video.videoWidth
    let height = $video.videoHeight
    let fps = DEFAULT_FPS

    // Keep encoding time and file size in check for large or long videos by
    // dropping the frame rate first, then scaling down
    if (width * height * duration * fps > PIXEL_BUDGET) {
      fps = 15
      if (width * height * duration * fps > PIXEL_BUDGET) {
        let scale = MAX_SCALED_SIZE / Math.max(width, height)
        if (scale < 1) {
          width = Math.round(width * scale / 2) * 2
          height = Math.round(height * scale / 2) * 2
        }
      }
    }

    let frameCount = Math.max(1, Math.floor(duration * fps))
    let delay = Math.round(1000 / fps)

    let $canvas = document.createElement('canvas')
    $canvas.width = width
    $canvas.height = height
    let context = $canvas.getContext('2d', {willReadFrequently: true})

    let getFrame = async (time) => {
      $video.currentTime = Math.min(time, Math.max(0, duration - 0.001))
      await waitFor($video, 'seeked')
      context.drawImage($video, 0, 0, width, height)
      return context.getImageData(0, 0, width, height).data
    }

    // A single palette shared by every frame, built from frames sampled across
    // the video, keeps encoding fast and the file small
    let sampleStep = Math.max(1, Math.floor(frameCount / PALETTE_SAMPLE_FRAMES))
    let samples = []
    for (let i = 0; i < frameCount; i += sampleStep) {
      samples.push(await getFrame(i / fps))
      if (samples.length == PALETTE_SAMPLE_FRAMES) break
    }

    let sampleData = new Uint8ClampedArray(samples.reduce((total, s) => total + s.length, 0))
    let offset = 0
    for (let sample of samples) {
      sampleData.set(sample, offset)
      offset += sample.length
    }
    let palette = quantize(sampleData, 256, {format: 'rgb565'})
    samples.length = 0

    let encoder = GIFEncoder({auto: false})
    encoder.writeHeader()

    for (let i = 0; i < frameCount; i++) {
      let frame = await getFrame(i / fps)
      let indexed = applyPalette(frame, palette, 'rgb565')
      encoder.writeFrame(indexed, width, height, {
        palette: i == 0 ? palette : undefined,
        first: i == 0,
        delay,
        repeat: 0,
      })
      onProgress?.((i + 1) / frameCount)
    }

    encoder.finish()
    return new Blob([encoder.bytesView()], {type: 'image/gif'})
  } finally {
    $video.removeAttribute('src')
    $video.load()
    URL.revokeObjectURL(objectUrl)
  }
}
