# [Control Panel for Twitter](https://soitis.dev/control-panel-for-twitter)

[![](icons/icon128.png)](https://soitis.dev/control-panel-for-twitter)

**Control Panel for Twitter is a browser extension for desktop and mobile browsers, which gives you more control over Twitter and adds missing features and UI improvements**

## About this fork

This is a fork of [insin/control-panel-for-twitter](https://github.com/insin/control-panel-for-twitter)
which **adds a download button to videos and GIFs**, using a bundled port of
[cobalt](https://github.com/imputnet/cobalt)'s Twitter service for the
downloading. Everything else works exactly like the upstream extension.

- **Videos** are saved as the highest quality mp4 Twitter has, with cobalt's
  `twitter_<id>.mp4` filenames.
- **GIFs** - which Twitter actually stores as silent mp4s - are converted to
  real `.gif` files in the browser, like cobalt's `convertGif` option does with
  ffmpeg. You can turn this off to save the original mp4.
- The button appears at the end of the action bar under tweets with a video or
  GIF, and in the media viewer.
- **Images** can be downloaded too, from the **Download image** item this adds
  to the share menu - which also downloads videos and GIFs, and every image in
  a tweet when you open it from the timeline.
- The share menu's **"Share post via…"** item can be hidden.
- No cobalt server is involved: the extraction and conversion both run inside
  the extension. If you [run your own cobalt
  instance](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md),
  you can point the extension at it in the options instead.

Options for all of this are under **Media downloads** on the extension's options
page. See [cobalt/README.md](cobalt/README.md) for how it's put together.

### Installing it

Download the repository, then load it as an unpacked extension in a
Chromium-based browser:

1. Run `npm install` and `npm run build-mv3` to create a build, or copy
   `manifest.mv3.json` to `manifest.json` to load the repository directly.
2. Go to `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked** and pick the folder.

> [!NOTE]
> This fork bundles AGPL-licensed code from cobalt, so it's distributed under
> the AGPL v3 - see [cobalt/README.md](cobalt/README.md#licensing). It isn't
> affiliated with insin or imputnet, and isn't in any extension store; please
> don't send bug reports about it to either project.

> [!IMPORTANT]
> This is the support repository for Control Panel for Twitter - for installation links, screenshots, information about the extension, and FAQs, please visit the [Control Panel for Twitter website](https://soitis.dev/control-panel-for-twitter).

Check the latest updates and availability for your browser on the [releases page](https://github.com/insin/control-panel-for-twitter/releases).

Follow [@ControlPanelFT](https://twitter.com/ControlPanelFT) on Twitter for extension news and other announcements.

## Support

To report a bug [create a new Issue](https://github.com/insin/control-panel-for-twitter/issues/new) here on GitHub.

Please include:

- The version of Control Panel for Twitter you're using
- The browser and operating system you're using it on
- Relevant URLs and screenshots if applicable

If you don't have a GitHub account, you can use the [Browser Extension Feedback & Support form](https://soitis.dev/extensions/feedback) on our website instead, or email [extensions@soitis.dev](mailto:extensions@soitis.dev).

## Attribution

Icon adapted from "Ibis icon" by [Delapouite](https://delapouite.com/) from [game-icons.net](https://game-icons.net), [CC 3.0 BY](https://creativecommons.org/licenses/by/3.0/)
