# Fusion Maker

A website for the phone that joins parts of several karaoke videos into one "fusion".

Everything happens inside the phone's browser. There is no server, no account and nothing is
uploaded: you pick videos that are already saved on the phone, and the finished fusion is saved
back to the phone.

## What it does

1. **Songs** – pick several videos at once, put them in order (arrows or drag), and tap **Trim**
   to keep only a part of each one while watching it.
2. **Joins** – choose how one song changes to the next (smooth blend, fade out/in, slide, wipe,
   circle, or no effect), how many seconds it takes, and an optional sound (whoosh, chime, drum
   roll, rising swell, or your own sound file). One join can be made different from the others,
   and any join can be previewed.
3. **Finish** – make a **video** (MP4) or **sound only** (MP3). The next song's name can be shown
   on screen just before each change.

Fusions are saved on the phone by themselves, including copies of the chosen videos, so a fusion
can be reopened later. A small backup file can move a fusion's settings to another phone.

## Where it works

| Device | Works? |
| --- | --- |
| Android phone or tablet, Chrome | Yes |
| iPhone / iPad, Safari, iOS 26 or newer | Should work (not tested on a real iPhone) |
| Laptop, Chrome or Edge | Yes |
| Firefox on Android, older iPhones | No (the page says so) |

The page must be opened with `https://` (GitHub Pages does this). It will not work from an
`http://192.168…` address.

## Put it online with GitHub Desktop (free)

The website is the `docs` folder. GitHub Pages serves it for free.

> **First, check who the commits will be signed as.** GitHub Desktop signs commits with the
> name and e-mail from the computer's Git settings, which on this computer may be a work
> identity. Because the repository must be public, do steps 3–4 **before** the first commit so
> that only your personal details appear.

1. On **github.com** (signed in to your personal account): **+** → **New repository** →
   name it `fusion-maker` → choose **Public** → leave every box unticked → **Create repository**.
2. In **GitHub Desktop**: **File → Clone repository…** → pick `fusion-maker` → choose where to
   put it (for example `Documents\GitHub\fusion-maker`) → **Clone**.
3. **Repository → Repository settings… → Git config** → choose **Use a local Git config** →
   type your personal name and the e-mail of your personal GitHub account → **Save**.
   (This only affects this one repository. Do not change **File → Options → Git**; that would
   change the settings the work account uses.)
4. Copy these from this folder into the cloned folder: `docs`, `tools`, `README.md`,
   `.gitignore`.
5. Back in GitHub Desktop the files appear under **Changes**. Type a summary such as
   `First version` → **Commit to main** → **Publish branch** (or **Push origin**).
6. On **github.com**, open the repository → **Settings → Pages** → under **Build and
   deployment** set **Source: Deploy from a branch**, **Branch: main**, folder **/docs** →
   **Save**.
7. Wait a minute or two and refresh that page. It shows the address:
   `https://YOUR-NAME.github.io/fusion-maker/`

Open that address on each phone. In Chrome choose **⋮ → Add to Home screen** (on iPhone:
**Share → Add to Home Screen**) to get an app icon. After the first visit it also opens
without internet.

### Changing the site later

Edit the files in the cloned folder → GitHub Desktop → **Commit to main** → **Push origin**.
The site updates by itself after about a minute.

## Good to know

- **Each phone keeps its own fusions.** They are stored in that phone's browser, not on GitHub.
  Clearing the browser's data for the site removes them (the original videos are never touched).
- **Making a video takes time and battery.** Keep the page open and the screen on until it
  finishes. A long fusion can take several minutes; how long depends on the phone (this has
  not been timed on a real phone yet). Choose **More choices → Smaller file** if a phone
  struggles.
- **Getting videos onto the phone** is up to you; this site does not download from YouTube.
  Only use videos you are allowed to use.
- Videos should be MP4 (most are). WebM and MKV work when the phone can play them.

## For developers

No build step. Plain HTML, CSS and JavaScript modules.

```
docs/               the website (this is what GitHub Pages serves)
  index.html, styles.css, sw.js, manifest.webmanifest
  js/app.js         screens and actions
  js/plan.js        timeline maths (30 frames per second grid)
  js/engine.js      draws every frame on a canvas and encodes it (WebCodecs)
  js/audio.js       sound reading, resampling, loudness, limiter, join sounds
  js/trim.js        the trim screen
  js/joins.js       the join chooser
  js/store.js       saving on the phone (localStorage + IndexedDB)
  js/media.js       reads a picked file (length, picture, sound)
  vendor/           Mediabunny (MPL-2.0) – reads and writes media files in the browser
tools/dev-server.mjs   local test server (not needed online)
```

Try it on this computer (needs Node.js):

```bash
node tools/dev-server.mjs
```

then open <http://localhost:8787>.

Thanks to [Mediabunny](https://mediabunny.dev) by Vanilagy, which does the reading, encoding and
file writing. Its licence is in `docs/vendor/LICENSE-mediabunny.txt`.
