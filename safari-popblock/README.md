# PopBlock: pop-up and redirect blocker for Safari on iPhone

A Safari Web Extension that blocks ads like AdGuard does. Its main job is the
problem content blockers handle poorly: **spam pop-ups, and taps that throw you
onto another website.**

## What it blocks

| Trick | How PopBlock stops it |
|---|---|
| Ad and pop-under networks (PopAds, PropellerAds, Adsterra, ExoClick, …) | Network rules block every request, including full-page redirects to them |
| `window.open` pop-ups and pop-unders | Blocked unless you tapped a link or button that leads there. The script gets a fake window back, so it doesn't fall back to redirecting your tab |
| A tap anywhere on the page opens an ad tab | Pop-ups from taps on text, images or the background are always blocked. In strict mode, cross-site pop-ups from buttons are blocked too (sign-in and payment windows like Google, Apple or PayPal still work) |
| Invisible full-screen layer that catches your tap | The layer is removed and that tap is stopped. Your next tap reaches the real page |
| Invisible ad link laid over a video player, or slipped under your finger mid-tap | The tap is stopped and the link removed |
| Pop-up that opens blank and is pointed at the ad afterwards | Blocked, so tapping a video thumbnail can't open an ad tab |
| Script borrows an untouched `window.open` from a hidden frame | Frames get the same guards as the page |
| Page sends the current tab to an ad after you tap (tab-under) | Stopped on Safari 26 and later |
| Script clicks a hidden ad link or submits a hidden form | Blocked unless you actually tapped a link to that site |
| Link swapping (the `href` changes when your finger touches the link) | The original link is put back before Safari follows it |
| New tab you didn't ask for | Closed, and you're returned to your page |
| Current tab jumps to another site after you tap plain content | Sent back to the page you were on (strict mode) |
| "Allow notifications?" spam | Denied automatically (strict mode) |
| Endless "You won an iPhone!" alert loops | Cut off after two alerts |
| Back button trap (history stuffing) | Extra history entries are ignored |
| Banner ads | Links, frames and images from ad networks are hidden, and so are banner-sized images that link to other sites |
| Empty ad boxes | Hidden with CSS |

It also works inside ad iframes, so an ad can't count its own domain as "same site".

To open the popup, tap the page menu button at the left end of Safari's address bar, then tap PopBlock. From there you can:
- **Protect this site**: turn it off for a site that misbehaves
- **Strict mode**: on by default
- See how much was blocked on this page and in total

## Option A: full extension (needs a Mac with Xcode)

iPhone extensions have to be wrapped in an app, and only Xcode can build that.
A free Apple ID is enough to put it on your own phone.

1. Copy this `safari-popblock` folder to a Mac with Xcode 15 or newer.
2. In Terminal:
   ```sh
   cd safari-popblock
   xcrun safari-web-extension-converter extension \
     --app-name PopBlock \
     --bundle-identifier com.yourname.popblock \
     --ios-only --swift --no-open --project-location build
   open build/PopBlock/PopBlock.xcodeproj
   ```
3. In Xcode, select the **PopBlock** project. For *both* targets (the app and
   the extension), open **Signing & Capabilities** and choose your team (your
   Apple ID).
4. Plug in your iPhone, pick it as the run destination, and press ▶ Run.
   On the phone, trust the developer under **Settings → General → VPN & Device
   Management**. Turn on **Developer Mode** if iOS asks.
5. Turn it on: **Settings → Apps → Safari → Extensions → PopBlock → Allow
   Extension**, then set **All Websites → Allow**. (Before iOS 18 the path is
   **Settings → Safari → Extensions**.)

Apps signed with a free Apple ID stop opening after 7 days. Run it from Xcode
again to renew. A paid developer account ($99/year) lasts a year.

Works on iOS 15.4 and later. iOS 17 or later is recommended: older Safari loads
the page guard a little later, so a pop-up that fires the instant a page opens
can get through.

## Option B: no Mac (userscript)

This gets you the page guard: pop-ups, tap layers, link swapping, scripted
clicks, notification spam, alert loops and history traps. It also hides banner
ads and stops ad scripts that are added after the page loads. It doesn't get
you full network blocking or the new-tab and redirect watchdog. **Keep AdGuard on
alongside it** for network blocking. The two work well together.

1. Install the free **Userscripts** app (by Justin Wasack) from the App Store.
2. Open the app and choose a folder for scripts.
3. Put `userscript/popblock.user.js` in that folder, e.g. through the Files app.
4. Turn it on under **Settings → Apps → Safari → Extensions → Userscripts →
   All Websites → Allow**.

## Project layout

```
extension/
  manifest.json        Manifest V3 extension
  inject.js            Page guard: runs before site scripts, in the page itself
  content.js           Passes settings to the guard and reports taps to background.js
  background.js        Closes unwanted tabs, undoes tap-jack redirects
  rules/ad_networks.json  Network block rules (generated)
  cosmetic.css         Hides empty ad slots
  popup.html/.css/.js  Settings popup
userscript/popblock.user.js   inject.js packaged for the Userscripts app (generated)
tools/domains.txt      Blocked domains. Edit this, then run the build
tools/build.py         Regenerates the rules and the userscript
tests/inject.test.js   Browser tests for the page guard
```

To block more domains, add them to `tools/domains.txt` and run
`python3 tools/build.py`.

To run the tests (needs Node and Playwright with Chromium):
`node tests/inject.test.js`

## Limits

- Safari only lets extensions see web pages. Pop-ups inside other apps, like
  in-app browsers, can't be blocked.
- No blocklist is ever complete. When an ad network moves to a new domain, the
  page guard still stops its pop-ups, but its banners may load until the
  domain is added.
- If a site you trust stops working (a checkout window won't open, say), turn
  off **Strict mode** or **Protect this site** for it in the popup.
