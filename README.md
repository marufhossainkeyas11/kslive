# 📺 KEYASLIVE (KSLIVE)

> Free live TV streaming — straight from your browser, no app needed.

**Live Demo → [marufhossainkeyas11.github.io/kslive](https://marufhossainkeyas11.github.io/kslive/)**

---

## ✨ Features

- 📡 **Live HLS Streaming** — plays live TV channels via HLS (`.m3u8`) streams directly in the browser
- 📱 **Progressive Web App (PWA)** — installable on Android & iOS, works offline after install
- 🖼️ **Picture-in-Picture** — watch while multitasking
- 🔊 **Volume Control** — built-in player controls
- 📋 **Channel Sidebar** — quick channel switching from a side panel
- ⚠️ **Stream Error Handling** — shows a clear message if a stream is offline or geo-restricted, with a retry option
- 🌐 **No account required** — open and watch, completely free

---

## 📲 Install as PWA

### Android (Chrome)
1. Open the site in Chrome
2. Tap the **⋮ menu** → **"Add to Home Screen"**
3. Tap **"Add"** — done!

### iOS (Safari)
1. Open the site in Safari
2. Tap the **Share button** (bottom toolbar)
3. Select **"Add to Home Screen"**
4. Tap **"Add"**

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML, CSS, Vanilla JavaScript |
| Streaming | HLS (HTTP Live Streaming) |
| PWA | Web App Manifest + Service Worker |
| Hosting | GitHub Pages |

---

## 🚀 Run Locally

```bash
git clone https://github.com/marufhossainkeyas11/kslive.git
cd kslive
# Open index.html in a browser, or use a local server:
npx serve .
```

> **Note:** Some streams may be BDIX-only or geo-restricted and will only work on supported networks.

---

## 📁 Project Structure

```
kslive/
├── index.html        # Main app shell
├── app.js            # Channel logic, HLS player, PWA install prompt
├── style.css         # UI styles
├── manifest.json     # PWA manifest
├── sw.js             # Service worker (offline support)
└── icons/            # PWA icons (192x192, 512x512)
```

---

## ⚠️ Disclaimer

This project streams publicly available or BDIX-hosted streams. It does not host or distribute any content. If a stream is unavailable, it may be offline, geo-restricted, or BDIX-only.

---

## 👤 Author

**Maruf Hossain Keyas**
GitHub: [@marufhossainkeyas11](https://github.com/marufhossainkeyas11)

---

<p align="center">Made with ❤️ for free TV access</p>
