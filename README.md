# Sidefold

Organize Subscriptions for YouTube™.

Sidefold is a Chrome extension (Manifest V3) that organizes your YouTube subscriptions into custom folders, directly in the sidebar.

## ✨ Features

- **Category sidebar** — folder-based sidebar injected into YouTube, grouping your subscribed channels by category
- **Bulk organizer panel** — floating modal with all your subscribed channels for quick assignment to folders
- **Category filter** — click a folder to see only the channels in that category, on `/feed/subscriptions`
- **Live search** — filter channels by name in real time, combinable with the category filter
- **Sort** — by most recent activity or alphabetically A→Z
- **Create & delete folders** — directly from the panel or popup, with a custom name and color
- **Bulk assign** — multi-select mode to assign multiple channels to a category at once
- **Open channel** — click a channel card to open it in a new tab
- **Dark mode** — fully compatible with YouTube's dark theme
- **Sync across devices** — categories and assignments sync via Chrome Sync (your own Google account)

## 🚀 Installation (developer mode)

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. Navigate to [youtube.com](https://www.youtube.com) — the sidebar and organizer button will appear automatically

## 🗂 Project structure

```
├── manifest.json
├── assets/
│   ├── icons/              # Extension icons (16, 32, 48, 128 px)
│   └── fonts/              # Roboto font (self-hosted)
├── _locales/               # i18n message files (en, es, ar, hi, id, pt_BR, zh_CN)
├── docs/
│   └── privacy.html        # Privacy policy (served via GitHub Pages)
└── src/
    ├── background/
    │   └── background.js   # Service worker — message relay
    ├── content/
    │   ├── content.js      # Orchestrator: SPA navigation, MutationObserver, injection
    │   ├── sidebar.js      # Category accordion sidebar injected into YouTube
    │   ├── sidebar.css
    │   ├── subscriptions-filter.js  # Category navbar on /feed/subscriptions
    │   └── video-label.js  # Categorize button on watch/channel pages
    ├── panel/
    │   ├── panel.js        # Content script bridge: fetches subscriptions, mounts iframe
    │   ├── panel-ui.js     # Panel UI rendered inside the iframe
    │   ├── panel.html
    │   └── panel.css
    ├── popup/
    │   ├── popup.html
    │   ├── popup.js
    │   └── popup.css
    └── shared/
        ├── i18n.js         # chrome.i18n wrapper + data-i18n attribute resolver
        ├── storage.js      # chrome.storage abstraction with in-memory cache
        └── utils.js        # Shared utilities
```

## 🔧 Permissions

| Permission | Reason |
|---|---|
| `storage` | Save folders, channel assignments and settings |
| `host_permissions: youtube.com` | Inject the sidebar and panel into YouTube pages |

No history, cookies, identity or sensitive data is requested.

## 🛠 Development

Files are loaded directly as content scripts — no bundler required. After any JS/CSS change, reload the extension card at `chrome://extensions`, then hard-reload the YouTube tab (`Cmd+Shift+R`).

**Validate JS syntax:**

```bash
node --check src/content/content.js
node --check src/content/sidebar.js
node --check src/panel/panel.js
node --check src/shared/storage.js
node --check src/shared/i18n.js
```

## 📝 Technical notes

- **Subscription fetching** — subscriptions are retrieved via `fetch('/feed/channels')`, parsing the `ytInitialData` JSON embedded in the page HTML. This avoids fragile DOM scraping and returns the full list reliably. Falls back to DOM scraping and a local cache if the fetch fails.
- **YouTube SPA navigation** — YouTube never does full page loads. `content.js` listens to `yt-navigate-finish` to reset injection state and re-inject after each navigation.
- **MutationObserver fallback** — if YouTube re-renders its sidebar and removes `#ycsm-sidebar`, the observer triggers re-injection automatically.
- **In-memory cache** — `storage.js` keeps a module-level `_memCache` to avoid repeated reads to `chrome.storage` on every sidebar render.
- **Canonical channel IDs** — legacy IDs like `/@handle` are automatically migrated to canonical `UCxxxxx` IDs when the panel opens.
- **Chrome Sync** — categories and assignments are stored in `chrome.storage.sync` and sync across the user's devices via their own Google account. The subscription list cache uses `chrome.storage.local`.

## 🔒 Privacy

This extension collects no personal data. All information (folders and assignments) is stored locally via `chrome.storage` and, if Chrome Sync is enabled, synced across your devices through your own Google account. No external servers, no analytics, no tracking.

Full privacy policy: **[Privacy policy](https://victorcouce.github.io/Sidefold/privacy)**

## 📄 License

MIT
