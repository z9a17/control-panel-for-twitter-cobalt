/**
 * Twitter/X media extraction engine.
 *
 * This is a browser port of cobalt's Twitter service, which is used under the
 * terms of the GNU AGPL v3 - see cobalt/COBALT-LICENSE and cobalt/README.md.
 *
 * Original: https://github.com/imputnet/cobalt
 *   api/src/processing/services/twitter.js - Copyright (c) imputnet
 *
 * Differences from the original, which all come from running inside a browser
 * extension instead of on a cobalt instance:
 * - fetch() is used directly instead of an undici dispatcher, and headers
 *   browsers don't let extensions set (user-agent, cookie) are dropped -
 *   cookies are sent by the browser itself when `credentials: 'include'` is
 *   used, which is how logged-in requests are made.
 * - Nothing is proxied or remuxed here; media URLs are returned as-is for the
 *   extension to download, and GIF conversion happens locally (cobalt/gif.js).
 */

const GRAPHQL_TWEET_URL = 'https://api.x.com/graphql/4Siu98E55GquhG52zHdY5w/TweetDetail'
const GUEST_TOKEN_URL = 'https://api.x.com/1.1/guest/activate.json'
const SYNDICATION_URL = 'https://cdn.syndication.twimg.com/tweet-result'

/** Public web client bearer token, as used by the Twitter web app. */
const BEARER_TOKEN = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'

const COMMON_HEADERS = {
  'authorization': BEARER_TOKEN,
  'x-twitter-client-language': 'en',
  'x-twitter-active-user': 'yes',
  'accept-language': 'en',
}

const TWEET_FEATURES = {
  rweb_video_screen_enabled: false,
  payments_enabled: false,
  rweb_xchat_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
}

const TWEET_FIELD_TOGGLES = {
  withArticleRichContentState: true,
  withArticlePlainText: false,
  withGrokAnalyze: false,
  withDisallowedReplyControls: false,
}

/**
 * Videos muxed during this window have a broken container and need remuxing to
 * play everywhere - cobalt does this server-side with ffmpeg, we can only flag
 * it.
 */
const TWITTER_EPOCH = 1288834974657n
const BAD_CONTAINER_START = 1701446400000
const BAD_CONTAINER_END = 1702605600000

let cachedGuestToken = null

/** @param {any} media */
function needsRemuxing(media) {
  let representativeId = media.source_status_id_str ?? media.id_str
  // The syndication API doesn't include media ids, so assume it's fine
  if (!representativeId) return false
  try {
    let mediaTimestamp = Number((BigInt(representativeId) >> 22n) + TWITTER_EPOCH)
    return mediaTimestamp > BAD_CONTAINER_START && mediaTimestamp < BAD_CONTAINER_END
  } catch {
    return false
  }
}

/** Strips the `tag` param, which cobalt does to get a stable, cacheable URL. */
function stripVideoURL(maybeUrl) {
  if (!maybeUrl) return maybeUrl
  let url = new URL(maybeUrl)
  url.searchParams.delete('tag')
  return url.toString()
}

/** Picks the highest bitrate mp4 variant, as cobalt does. */
function bestQuality(variants) {
  let mp4s = (variants || []).filter((v) => v.content_type == 'video/mp4')
  if (mp4s.length == 0) return null
  return stripVideoURL(
    mp4s.reduce((a, b) => Number(a?.bitrate) > Number(b?.bitrate) ? a : b).url
  )
}

async function getGuestToken(forceReload = false) {
  if (cachedGuestToken && !forceReload) return cachedGuestToken
  try {
    let response = await fetch(GUEST_TOKEN_URL, {
      method: 'POST',
      headers: COMMON_HEADERS,
      credentials: 'omit',
    })
    if (!response.ok) return null
    let json = await response.json()
    if (json?.guest_token) return cachedGuestToken = json.guest_token
  } catch {}
  return null
}

/**
 * @param {string} id tweet id
 * @param {string} guestToken
 * @param {string} [csrfToken] ct0 cookie value - when given, the request is
 *   made as the logged-in user, which is how private, age-restricted and
 *   subscriber-only posts are fetched.
 */
async function requestTweet(id, guestToken, csrfToken) {
  let url = new URL(GRAPHQL_TWEET_URL)
  url.searchParams.set('variables', JSON.stringify({
    focalTweetId: id,
    with_rux_injections: false,
    rankingMode: 'Relevance',
    includePromotedContent: true,
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: true,
    withBirdwatchNotes: true,
    withVoice: true,
  }))
  url.searchParams.set('features', JSON.stringify(TWEET_FEATURES))
  url.searchParams.set('fieldToggles', JSON.stringify(TWEET_FIELD_TOGGLES))

  let headers = {...COMMON_HEADERS, 'content-type': 'application/json'}
  if (csrfToken) {
    headers['x-twitter-auth-type'] = 'OAuth2Session'
    headers['x-csrf-token'] = csrfToken
  } else {
    headers['x-guest-token'] = guestToken
  }

  return fetch(url, {
    headers,
    // The browser attaches the user's x.com cookies for logged-in requests
    credentials: csrfToken ? 'include' : 'omit',
  })
}

async function requestSyndication(id) {
  // Token generation from yt-dlp, via cobalt
  let token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
  let url = new URL(SYNDICATION_URL)
  url.searchParams.set('id', id)
  url.searchParams.set('token', token)
  return fetch(url, {credentials: 'omit'})
}

/** Media attached to a tweet via a card, e.g. promoted video websites. */
function parseCard(cardOuter) {
  try {
    let card = JSON.parse((
      cardOuter?.legacy?.binding_values[0].value || cardOuter?.binding_values?.unified_card
    )?.string_value)

    if (!['video_website', 'image_website'].includes(card?.type) ||
        !card?.media_entities ||
        card?.component_objects?.media_1?.type !== 'media') {
      return
    }

    let mediaId = card.component_objects?.media_1?.data?.id
    return [card.media_entities[mediaId]]
  } catch {}
}

/**
 * @returns {{media?: any[], user?: any, error?: string}}
 */
function extractGraphqlMedia(thread, id, csrfToken) {
  let addEntries = thread?.data?.threaded_conversation_with_injections_v2?.instructions?.find(
    (insn) => insn.type == 'TimelineAddEntries'
  )

  let tweetResult = addEntries?.entries?.find(
    (entry) => entry.entryId == `tweet-${id}`
  )?.content?.itemContent?.tweet_results?.result

  let typename = tweetResult?.__typename

  if (!typename) return {error: 'empty'}

  if (typename == 'TweetUnavailable' || typename == 'TweetTombstone') {
    let reason = tweetResult?.reason ?? tweetResult?.result?.reason
    if (reason == 'Protected') return {error: 'private'}
    if (reason == 'NsfwLoggedOut' ||
        tweetResult?.tombstone?.text?.text?.startsWith('Age-restricted')) {
      return {error: csrfToken ? 'unavailable' : 'age'}
    }
  }

  if (!['Tweet', 'TweetWithVisibilityResults'].includes(typename)) {
    return {error: 'unavailable'}
  }

  let result = typename == 'TweetWithVisibilityResults' ? tweetResult.tweet : tweetResult
  let baseTweet = result.legacy
  let repostedTweet = baseTweet?.retweeted_status_result?.result
  let repostedLegacy = repostedTweet?.tweet?.legacy ?? repostedTweet?.legacy

  let user = (
    repostedTweet?.core?.user_results?.result ??
    repostedTweet?.tweet?.core?.user_results?.result ??
    result?.core?.user_results?.result
  )

  if (tweetResult.card?.legacy?.binding_values?.length) {
    let cardMedia = parseCard(tweetResult.card)
    if (cardMedia) return {media: cardMedia, user}
  }

  let media = repostedLegacy?.extended_entities?.media ?? baseTweet?.extended_entities?.media
  return {media, user}
}

/**
 * Fetches the media attached to a tweet, trying the same sources in the same
 * order as cobalt: the GraphQL API as a guest, then as the logged-in user,
 * then the tweet embed (syndication) API.
 *
 * @param {{id: string, csrfToken?: string}} options
 * @returns {Promise<{media: any[], screenName?: string, error?: string}>}
 */
export async function getTweetMedia({id, csrfToken}) {
  let guestToken = await getGuestToken()
  if (!guestToken) return {media: [], error: 'fetchFailed'}

  let response = await requestTweet(id, guestToken)

  if ([403, 404, 429].includes(response.status)) {
    if ([403, 429].includes(response.status)) {
      guestToken = await getGuestToken(true)
    }
    response = await requestTweet(id, guestToken, csrfToken)
  }

  let media
  let user
  let error

  try {
    let extracted = extractGraphqlMedia(await response.json(), id, csrfToken)
    ;({media, user, error} = extracted)
  } catch {}

  // Private, age-restricted and subscriber-only posts may be visible to the
  // logged-in user, so retry as them before giving up
  if (!media?.length && csrfToken && ['age', 'private', 'unavailable'].includes(error)) {
    try {
      let retry = await requestTweet(id, guestToken, csrfToken)
      let extracted = extractGraphqlMedia(await retry.json(), id, csrfToken)
      media = extracted.media
      user = extracted.user ?? user
      error = extracted.error
    } catch {}
  }

  // If the GraphQL requests failed, fall back to the tweet embed API
  if (!media?.length) {
    try {
      let tweet = await (await requestSyndication(id)).json()
      if (tweet?.card) {
        media = parseCard(tweet.card) ?? media
      }
      media = tweet?.mediaDetails ?? media
      user = user ?? tweet?.user
    } catch {}
  }

  if (!media?.length) return {media: [], error: error || 'empty'}

  return {
    media,
    screenName: user?.core?.screen_name ?? user?.legacy?.screen_name ?? user?.screen_name,
  }
}

/**
 * Turns Twitter media entities into a list of downloadable items, using
 * cobalt's quality selection and file naming.
 *
 * @param {{
 *   media: any[],
 *   id: string,
 *   screenName?: string,
 *   index?: number,
 *   includeAuthor?: boolean,
 *   convertGifs?: boolean,
 *   photos?: boolean,
 * }} options
 * @returns {import("../types").CobaltMediaItem[]}
 */
export function toDownloadItems({media, id, screenName, index, includeAuthor, convertGifs, photos = false}) {
  let hasIndex = index != null && index >= 0 && index < media.length
  // A specific item was asked for, e.g. /photo/2 or /video/1 in the media viewer
  let items = hasIndex ? [media[index]] : media

  let base = includeAuthor && screenName ? `twitter_${screenName}_${id}` : `twitter_${id}`

  let downloadItems = items.map((item, i) => {
    // cobalt numbers files by their position in the tweet
    let position = hasIndex ? index : i
    let suffix = media.length > 1 ? `_${position + 1}` : ''

    if (item.type == 'photo') {
      if (!photos) return null
      let extension = new URL(item.media_url_https).pathname.split('.').pop()
      return {
        type: 'photo',
        url: `${item.media_url_https}?name=4096x4096`,
        filename: `${base}${suffix}.${extension}`,
      }
    }

    let url = bestQuality(item.video_info?.variants)
    if (!url) return null

    let isGif = item.type == 'animated_gif'
    return {
      type: isGif ? 'gif' : 'video',
      url,
      filename: `${base}${suffix}.${isGif && convertGifs ? 'gif' : 'mp4'}`,
      convertToGif: Boolean(isGif && convertGifs),
      needsRemuxing: needsRemuxing(item),
      durationMs: item.video_info?.duration_millis,
    }
  })

  return /** @type {import("../types").CobaltMediaItem[]} */ (downloadItems.filter(Boolean))
}
