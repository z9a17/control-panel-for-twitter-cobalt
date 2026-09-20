# cobalt media downloading

This folder is the media downloading feature which this fork adds: a download
button on tweets with a video or GIF in them, and a download item in the share
menu which handles images too, both powered by a bundled port of
[cobalt](https://github.com/imputnet/cobalt)'s Twitter service.

Nothing here talks to `api.cobalt.tools` or any other public instance - hosted
cobalt instances [aren't meant to be used by other
projects](https://github.com/imputnet/cobalt/blob/main/docs/api.md), so the
parts of cobalt which are needed to download Twitter media run inside the
extension instead. If you run your own instance, you can point the extension at
it in the options.

## What's in here

| File | Runs in | What it does |
|:--|:--|:--|
| `button.js` | the Twitter page | Adds the download button to action bars and the media viewer, and the download item to the share menu |
| `download.js` | the background script | Works out what to download, converts GIFs, saves files |
| `engine.js` | the background script | cobalt's Twitter extraction: finds the media in a tweet and picks the best quality |
| `instance.js` | the background script | Client for your own cobalt instance, if you configure one |
| `gif.js` | offscreen document (MV3) / background page (MV2) | Converts Twitter's GIF videos into real `.gif` files |
| `offscreen.html`, `offscreen.js` | offscreen document | Gives `gif.js` a DOM to decode video frames with, which MV3 service workers don't have |
| `vendor/gifenc.js` | with `gif.js` | GIF encoder |

## How a download works

1. `button.js` posts a message with the tweet id (and the media index, in the
   media viewer) to `content.js`, which forwards it to the background script.
   Downloads started from the share menu also ask for images, which the
   download button ignores.
2. `engine.js` asks Twitter's GraphQL API for the tweet as a guest, retries as
   the logged-in user if that's refused, and falls back to the tweet embed API -
   the same order cobalt uses. It returns the highest bitrate mp4 for each video
   and GIF, and cobalt's `twitter_<id>.mp4` style filenames.
3. If the media is a GIF and "Save GIFs as .gif files" is on, `gif.js` decodes
   the mp4 frame by frame, quantises a shared 256 colour palette and encodes a
   GIF - this is what cobalt does with ffmpeg server-side.
4. The file is saved with `chrome.downloads`.

The share menu has nothing in it which identifies it, so `button.js` uses the
share button click which opened it as the cue, and finds its "Share post via…"
item - the one the "hide" option removes - by the icon it shares with the
button which was clicked.

## Licensing

`engine.js` is a port of `api/src/processing/services/twitter.js` from cobalt,
which is licensed under the **GNU AGPL v3** - see `COBALT-LICENSE`. Because of
that, this fork as a whole is distributed under the AGPL v3; Control Panel for
Twitter itself remains MIT licensed (see `../LICENSE`) and can be used under
those terms on its own.

`vendor/gifenc.js` is [gifenc](https://github.com/mattdesl/gifenc) by Matt
DesLauriers, MIT licensed - see `vendor/gifenc.LICENSE.md`.
