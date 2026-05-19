# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome extension (Manifest V3) that injects a category sidebar into YouTube. No build step, no bundler — files are loaded directly as content scripts.

## Development workflow

**Load the extension:**
1. Open `chrome://extensions` → Enable Developer mode → Load unpacked → select this folder.
2. After any JS/CSS change, click the refresh icon on the extension card in `chrome://extensions`.
3. Then hard-reload the YouTube tab (`Cmd+Shift+R`).

**Validate JS syntax** (no test runner exists):
```bash
node --check src/content/sidebar.js
node --check src/content/content.js
node --check src/panel/panel.js
node --check src/shared/storage.js
node --check src/shared/i18n.js
```

## Architecture

All modules attach themselves to a single global namespace `window.YCSM` so content scripts loaded in sequence can reference each other. Load order (defined in `manifest.json`) is:

1. `src/shared/i18n.js` → `window.YCSM.i18n` — wrapper around `chrome.i18n.getMessage` and helpers for localized HTML attributes.\n2. `src/shared/storage.js` → `window.YCSM.storage` — abstraction over `chrome.storage.sync/local` with an in-memory cache. Categories/assignments go to `sync`; channel list cache goes to `local`.
3. `src/content/sidebar.js` → `window.YCSM.sidebar` — builds and renders the accordion sidebar injected into YouTube's guide/nav rail.
4. `src/panel/panel.js` → `window.YCSM.panel` — floating iframe panel for bulk channel assignment.
5. `src/content/subscriptions-filter.js` → `window.YCSM.subscriptionsFilter` — injects the category navbar on `/feed/subscriptions`.
6. `src/content/video-label.js` → `window.YCSM.videoLabel` — injects the category button on watch/channel pages.
7. `src/content/content.js` — orchestrator: sets up `MutationObserver`, listens to YouTube SPA events (`yt-navigate-finish`, `yt-page-data-updated`), triggers re-injection on DOM changes, and relays messages from the popup.

**`src/background/background.js`** — minimal service worker. Forwards `openPanel` / `refreshSidebar` messages from the popup to the active tab's content script.

**`src/popup/popup.html|js`** — extension popup. Reads categories via `chrome.storage` and sends messages to background.

**`src/panel/panel.html`** — loaded as a web-accessible resource inside an iframe by `panel.js`. Has its own script context; communicates back to the content script via `window.parent.postMessage`.

## Key patterns

- **YouTube SPA navigation** — YouTube never does full page loads. `content.js` listens to `yt-navigate-finish` to reset injection state and re-inject after each navigation. `yt-page-data-updated` handles partial re-renders.
- **MutationObserver fallback** — if YouTube re-renders its sidebar and removes `#ycsm-sidebar`, the observer triggers re-injection automatically.
- **Storage cache invalidation** — `storage.js` keeps a module-level `_memCache`. Any `syncSet` call updates the cache in place; `chrome.storage.onChanged` (from another tab/device) calls `invalidateCache()`.
- **Channel ID canonicalization** — legacy IDs like `/@handle` are migrated to canonical `UCxxxxx` IDs when the panel opens.
- **Subscription fetching** — `fetch('/feed/channels')` + parse `ytInitialData` JSON embedded in the HTML. This bypasses DOM scraping and returns the full subscription list reliably.
- **RSS lazy-loading** — last-video dates are fetched in parallel (max 15 concurrent) from `https://www.youtube.com/feeds/videos.xml?channel_id=...`.

## Internationalisation

`src/shared/i18n.js` wraps `chrome.i18n.getMessage`. In HTML, use `data-i18n`, `data-i18n-html`, `data-i18n-title`, `data-i18n-placeholder`, or `data-i18n-aria-label` attributes; `YCSM.i18n.apply(root)` resolves them. In JS, use `YCSM.i18n.t('key')`. Message files live in `_locales/<lang>/messages.json` (en, es, ar, hi, id, pt_BR, zh_CN).

## MV3 gotchas

- The service worker can die at any time. `storage.js` guards every `chrome.storage` call with `isContextValid()` to avoid unhandled "Extension context invalidated" rejections.
- `chrome.storage` calls in MV3 return Promises; always use `.catch()` rather than error callbacks.
- `panel.html` must be listed under `web_accessible_resources` in `manifest.json` to be loadable inside an iframe on youtube.com.
