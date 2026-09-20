/**
 * Client for a cobalt API instance, for people who run their own.
 *
 * The bundled engine (cobalt/engine.js) handles Twitter on its own and is what
 * the extension uses by default. If a cobalt instance is configured in the
 * options, it's used instead, which is useful if you want cobalt's server-side
 * processing (remuxing, tunnelling) instead of doing everything in the browser.
 *
 * Request and response formats: https://github.com/imputnet/cobalt/blob/main/docs/api.md
 */

/**
 * @param {string} instanceUrl
 * @param {string} tweetUrl
 * @param {{apiKey?: string, convertGifs?: boolean, alwaysProxy?: boolean}} options
 * @returns {Promise<{items?: import("../types").CobaltMediaItem[], error?: string}>}
 */
export async function getInstanceMedia(instanceUrl, tweetUrl, {apiKey, convertGifs, alwaysProxy} = {}) {
  let endpoint
  try {
    endpoint = new URL(instanceUrl)
  } catch {
    return {error: 'badInstanceUrl'}
  }

  let headers = {
    'accept': 'application/json',
    'content-type': 'application/json',
  }
  if (apiKey) {
    // Full header values like "Bearer <token>" are passed through as-is
    headers['authorization'] = /^(api-key|bearer) /i.test(apiKey) ? apiKey : `Api-Key ${apiKey}`
  }

  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      credentials: 'omit',
      body: JSON.stringify({
        url: tweetUrl,
        convertGif: Boolean(convertGifs),
        alwaysProxy: Boolean(alwaysProxy),
        filenameStyle: 'classic',
      }),
    })
  } catch (e) {
    return {error: 'instanceUnreachable'}
  }

  let json
  try {
    json = await response.json()
  } catch {
    return {error: 'instanceBadResponse'}
  }

  /** @type {import("../types").CobaltMediaItem[]} */
  let items

  switch (json?.status) {
    case 'tunnel':
    case 'redirect':
      items = [{
        type: json.filename?.endsWith('.gif') ? 'gif' : 'video',
        url: json.url,
        filename: json.filename,
      }]
      break

    case 'local-processing':
      // cobalt wants us to remux/convert the files ourselves. We can do that
      // for Twitter GIFs; anything else is downloaded as-is.
      items = [{
        type: json.type == 'gif' ? 'gif' : 'video',
        url: json.tunnel?.[0],
        filename: json.output?.filename ?? 'twitter_video.mp4',
        convertToGif: json.type == 'gif',
      }].filter((item) => item.url)
      break

    case 'picker':
      items = (json.picker ?? []).map((item, i) => ({
        type: item.type == 'photo' ? 'photo' : item.type == 'gif' ? 'gif' : 'video',
        url: item.url,
        filename: `twitter_${i + 1}.${item.type == 'photo' ? 'jpg' : item.type == 'gif' ? 'gif' : 'mp4'}`,
      }))
      break

    case 'error':
      return {error: json.error?.code ?? 'instanceError'}
  }

  if (items) return {items}

  return {error: 'instanceBadResponse'}
}
