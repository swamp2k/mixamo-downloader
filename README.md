# mixamo-downloader

A resilient terminal downloader for the Mixamo animation catalog, driven through a real Chromium session with Playwright.

The goal is simple: download a large Mixamo library without losing hours of progress because one React control was slow, a modal rerendered, or a download took longer than expected.

## What it does

- Uses a persistent Chromium profile, so your Adobe/Mixamo login survives restarts.
- Opens the Mixamo animation catalog with `96` items per page.
- Downloads through the normal Mixamo UI; it does not depend on Mixamo's undocumented download API.
- Waits for Playwright's real `download` event before marking an item complete.
- Re-queries UI controls after rerenders instead of holding stale DOM references.
- Retries selection, `In Place`, modal and download failures with backoff.
- Saves state after every successful or failed item.
- Resumes safely after a crash or Ctrl+C.
- Runs a final failure-only retry pass after the catalog pass.

## Install

Requires Node.js 20+.

```bash
npm install
npx playwright install chromium
```

## First run

```bash
npm start -- --output ./mixamo
```

A Chromium window opens. If Mixamo needs a login, log in normally. The CLI will wait for you and then continue.

By default the downloader uses:

- FBX Binary
- Without Skin
- 30 FPS
- No Keyframe Reduction
- In Place: enabled
- Pages 1-26
- 96 items per page

Files are stored below the output directory. Progress is kept in `.mixamo-state.json`, and the persistent login profile defaults to `.mixamo-profile` in the current working directory.

For a small smoke test before committing to the full catalog:

```bash
npm start -- --output ./mixamo-test --end-page 1 --max-items 3
```

Then run the real job:

```bash
npm start -- --output ./mixamo
```

Useful options:

```text
--output <dir>                 Download/state directory (default: ./mixamo-downloads)
--profile <dir>                Persistent Chromium profile (default: ./.mixamo-profile)
--start-page <n>               First catalog page (default: 1)
--end-page <n>                 Last catalog page (default: 26)
--limit <n>                    Items per catalog page (default: 96)
--max-items <n>                Limit items processed per page; useful for testing
--attempts <n>                 Attempts per item (default: 5)
--download-timeout-ms <n>      Wait for a real browser download event (default: 90000)
--in-place / --no-in-place     Desired In Place state (default: enabled)
--with-skin                    Download with skin (default: without skin)
--fps <n>                      Preferred FPS (default: 30)
--headless                     Run Chromium headless (not recommended for the first run)
--reset-state                  Clear progress state before starting
--no-final-retry               Skip the final failure-only pass
```

Press `Ctrl+C` to stop. State is written item-by-item, so starting the same command again resumes rather than beginning from scratch.

## Why Playwright?

The browser-console script this project was inspired by has to infer download success by sleeping after a click. Playwright can observe the browser's actual download event and wait for the file to be saved. Its locators also re-resolve against the live DOM, which is useful on Mixamo's React UI where controls can be replaced during rerenders.

The original modernized browser-console work is by Jake Cattrall and contributors:

https://gist.github.com/krazyjakee/1e3592856dd636b8043cc359ad9d66fc

That script in turn credits earlier Mixamo downloader work by LouisGameDev. This repository is a separate implementation, but the current Mixamo selectors and defensive-automation ideas were informed by that work.

## Caveat

Mixamo's web UI is not a documented automation API. Adobe can change markup or behavior at any time. The downloader therefore treats selectors as fallible, retries transient failures, and records enough state to resume after selector fixes.
