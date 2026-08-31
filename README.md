# Spotify No Ads - Titanium Based

> App Spotify Không Quảng Cáo, xây trên nền **Titanium Browser (Chromium + Vanadium)**. Trải nghiệm như app native: không thanh địa chỉ, tự động mở `open.spotify.com`, ép **Desktop Mode** từ đầu, preload sẵn **PureBeat Core v2.2.0** chặn ads, Media Notification chuẩn như app nghe nhạc.

[![Build](https://github.com/devprpvip/spotify-no-ads/actions/workflows/build.yml/badge.svg)](https://github.com/devprpvip/spotify-no-ads/actions/workflows/build.yml)

## Tính năng chính

- **Không thanh địa chỉ (App-like)**: ẩn Toolbar/Omnibox hoàn toàn, fullscreen như WebView nhưng vẫn là Chromium đầy đủ.
- **Auto-load Spotify**: mọi tab mới / khởi động đều vào `https://open.spotify.com`, chặn điều hướng ra ngoài.
- **Force Desktop Mode**: `is_desktop_android=true` + UA desktop `X11 Linux` + `useDesktopUserAgentForUrl` cho `open.spotify.com` → tránh lỗi extension khi Spotify trả về mobile layout.
- **Preload PureBeat Core v2.2.0**: đóng gói sẵn trong `extensions/dist/purebeat.crx` + `bundled.json`, tự stage qua `StageBundledExtensions` (Titanium mechanism). Không cần cài thêm.
- **Media Notification native-like**: 
  - `setOngoing(true)`, `setAutoCancel(false)`, `VISIBILITY_PUBLIC`, `IMPORTANCE_HIGH`
  - Patch `render_frame_media_playback_options.cc` (`#if 0`) cho phép background playback
  - Không `Suspend` MediaSession khi app background → notification không mất nửa nạc nửa mỡ như Chrome mobile.
  - `FOREGROUND_SERVICE_MEDIA_PLAYBACK` + `mediaPlayback` foregroundServiceType
- **Hỗ trợ Android 10 → mới nhất**: `minSdk 29`, build 2 ABI `armeabi-v7a` + `arm64-v8a` + AAB.
- **Branding Spotify**: package `com.devprp.spotifynoads`, tên `Spotify`, icon xanh #1DB954.

## Cấu trúc dự án (fork Titanium)

```
spotify-no-ads/
├── args.gn                  # GN build config, package com.devprp.spotifynoads
├── build.sh                 # Build script (fetch Chromium + apply Vanadium patches + patch.sh)
├── common.sh
├── patch.sh                 # Titanium patches + Spotify custom (no address bar, homepage, desktop, media)
├── res/
│   ├── icon.svg             # Spotify green icon template
│   └── drawable/themed_app_icon.xml
├── extensions/
│   ├── dist/                # PureBeat Core unpacked + purebeat.crx + bundled.json
│   ├── BUILD.gn
│   └── stage_bundled_extensions.inc
├── .gclient                 # Chromium + Vanadium hooks
└── .github/workflows/build.yml
```

## Cách hoạt động

1. `patch.sh` chạy sau khi `gclient sync`:
   - Copy `themed_app_icon.xml` + xử lý `icon.svg` (không tint navy, giữ #1DB954).
   - Branding strings → `Spotify`.
   - `AndroidManifest.xml` → label Spotify, `minSdk 29`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`.
   - Copy `extensions/dist` → `titanium/dist` và hook `external_pref_loader.cc` để auto-install PureBeat.
   - Ẩn toolbar: `toolbar_phone.xml` visibility gone + `ToolbarManager` set GONE.
   - Force homepage `open.spotify.com` (patch `ChromeTabbedActivity`, `url_constants`).
   - Force Desktop UA cho spotify.
   - Media patches: ongoing notification, không suspend, giữ audio focus, importance HIGH.
   - Bypass CRX signature cho `purebeat.crx` (header_size 0).

2. `args.gn` bật `is_desktop_android=true`, `proprietary_codecs=true`, `enable_av1_decoder`, v.v.

3. GitHub Actions build trên `ubuntu-latest` (hoặc self-hosted), sign APK/AAB bằng `LOCAL_TEST_JKS`/`STORE_TEST_JKS` secrets.

## Build local (cần Linux + 100GB disk)

```bash
# Fork repo này, set secrets keystore base64
# LOCAL_TEST_JKS, STORE_TEST_JKS như Titanium
git clone --recursive https://github.com/devprpvip/spotify-no-ads
cd spotify-no-ads
git submodule update --init
./build.sh  # sẽ clone Chromium src, apply patches, gn gen, autoninja
# Output: chromium/src/out/release/*.apk / *.aab
```

Hoặc push lên GitHub → Actions tự build.

## Cài đặt

- Tải APK từ Releases: `*-arm64-v8a.apk` (máy mới) hoặc `*-armeabi-v7a.apk` (máy cũ Android 10).
- Cài đặt → mở app → tự vào Spotify Web Player desktop → đăng nhập → phát nhạc → kiểm tra notification có điều khiển Play/Pause/Next, artwork, không bị mất khi lock screen.

## Media Notification - Tại sao không như Chrome mobile?

Chrome mobile mặc định `Suspend` MediaSession khi tab background → notification biến mất. App này patch:
- `content/public/renderer/render_frame_media_playback_options.cc` → `#if 0`
- `content/browser/media/media_session.cc` + `media_session_impl.cc` → không SetSuspended
- `MediaNotificationManager.java` → ongoing + public visibility

Kết quả: notification tồn tại như Spotify native, điều khiển từ lockscreen, headset, Android Auto.

## PureBeat Core v2.2.0

- Manifest V3, `content_scripts` chỉ `https://open.spotify.com/*`
- `injected/main.js` hook `fetch` + `WebSocket` để dọn state machine, bỏ track `:ad:`.
- Đã bundle sẵn, không cần cài thêm. Update bằng cách thay `extensions/dist/*` và rebuild.

## Publish lên GitHub

```bash
cd /project/workspace/spotify-no-ads
git init
git remote add origin https://github.com/minhhau361/spotify-no-ads.git
git add .
git commit -m "feat: Spotify No Ads - initial Titanium fork"
git push -u origin main
# Sau đó vào Actions → Run workflow → đợi build (~2-3h)
```

Cần tạo 2 secrets trong repo Settings → Secrets and variables → Actions:
- `LOCAL_TEST_JKS`: `base64 -w0 local.properties` (chứa keyAlias, keyPassword, storePassword)
- `STORE_TEST_JKS`: `base64 -w0 test.jks`

## License

GPLv2 như Titanium/Vanadium. Icon Spotify thuộc Spotify AB, chỉ dùng cho mục đích cá nhân.

## Credits

- [Titanium Browser](https://github.com/jqssun/android-titanium-browser) + [Vanadium/GrapheneOS](https://github.com/GrapheneOS/Vanadium)
- PureBeat Core
