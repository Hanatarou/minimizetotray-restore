# MinimizeToTray Restore

[![Release](https://img.shields.io/github/v/release/Hanatarou/minimizetotray-restore)](https://github.com/Hanatarou/minimizetotray-restore/releases/latest)
[![Build](https://img.shields.io/github/actions/workflow/status/Hanatarou/minimizetotray-restore/release.yml)](https://github.com/Hanatarou/minimizetotray-restore/actions)
[![Downloads (all releases)](https://img.shields.io/github/downloads/Hanatarou/minimizetotray-restore/total?label=downloads%20%28all%29)](https://github.com/Hanatarou/minimizetotray-restore/releases)
[![Downloads (latest release)](https://img.shields.io/github/downloads/Hanatarou/minimizetotray-restore/latest/total?label=downloads%20%28latest%29)](https://github.com/Hanatarou/minimizetotray-restore/releases/latest)
[![License: MIT](https://img.shields.io/github/license/Hanatarou/minimizetotray-restore)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Language](https://img.shields.io/github/languages/top/Hanatarou/minimizetotray-restore)
![Thunderbird](https://img.shields.io/badge/Thunderbird-154%2B-0a84ff)

## 🤖 A Note on AI Usage

I built this project alone, as a personal project, with substantial help from AI tools — Z.ai (GLM) and Claude. I believe knowledge only survives past us if it's shared, and that's the spirit behind releasing this for free.

I did this on my own time and dime, covering all costs myself, without asking anyone for donations.

Just as I respect opinions against the use of AI, I expect the use of AI here — as a tool that helped me build this project — to be respected in return. Disrespect toward this work, toward me, or toward anyone else involved will not be tolerated.

All AI-generated content is reviewed and validated by me before being committed — I stand behind every decision to include code in this repository, regardless of how it was originally written. This project is still provided as-is, under the MIT license below, with no warranty of any kind.

If you're uncomfortable with AI-assisted code for any reason, you are under no obligation to use, contribute to, or engage with this project. No hard feelings — just move on.

For everyone else: bug reports and PRs are evaluated on their merits (does it work, is it correct), not on how the code was produced.

## 📖 What it does

Restores the classic "minimize to tray" behavior that Thunderbird removed in
version 154, using the same native Windows OS integration API
(`nsIMessengerWindowsIntegration`) Thunderbird itself uses internally for its
"Close to Tray" feature.

**Windows only.** This relies on a Windows-specific native interface that
doesn't exist on Linux or macOS builds of Thunderbird — the add-on detects
the platform and does nothing on non-Windows systems.

## Features

- **Minimize to tray** — clicking the minimize button hides Thunderbird to
  the system tray instead of the taskbar.
- **Start minimized** (optional) — Thunderbird starts hidden in the tray,
  with no window flash from the second restart onward.
- **Optional native Close to Tray** — off by default, so the close (X)
  button keeps quitting Thunderbird as usual.
- **Tray tooltip with unread counts per account** (e.g.
  "work: 3\npersonal: 12"), kept correct even through Thunderbird's own
  native tray icon churn at startup (see below).
- **Taskbar badge sync** — the unread badge on the Windows taskbar icon is
  repainted with the same reliably-computed count as the tray icon, so the
  two indicators always agree (see below).
- Works around a Thunderbird core bug where the message pane / thread pane
  split resets when the window starts hidden.

## Installation

1. Download the latest `.xpi` from the [Releases](../../releases) page.
2. In Thunderbird: **Tools/hamburger menu → Add-ons and Themes → gear icon
   → Install Add-on From File...** and select the downloaded `.xpi`.
3. Open the add-on's **Options** to enable "Start minimized" if you want it.

## Building from source

```sh
git clone https://github.com/Hanatarou/minimizetotray-restore.git
cd minimizetotray-restore
zip -r -X minimizetotray-restore.xpi manifest.json background.js _locales api options icons
```

Release builds are produced automatically: pushing a `v*` tag (or publishing
a release) triggers the [Build XPI](.github/workflows/release.yml) workflow,
which attaches `minimizetotray-restore-v<version>.xpi` and its
`minimizetotray-restore-v<version>.xpi.sha256.txt` checksum to the release.

## How it works

Uses a [WebExtension Experiment](https://webextension-api.thunderbird.net/en/latest/how-to/experiments.html)
to call `nsIMessengerWindowsIntegration.hideWindow()` and
`nsIMessengerOSIntegration.updateUnreadCount()` — the same internal
services Thunderbird's own tray integration uses.

For "start minimized" with zero flash, the add-on temporarily enables the
native `mail.closeToTray` / `mail.closeToTray.startInTray` prefs right
before Thunderbird quits, then disables `mail.closeToTray` again once
running, so the close (X) button keeps its normal behavior unless "Also
minimize to tray when closing" is explicitly enabled.

For the tray tooltip, Thunderbird's own native `MailNotificationManager`
independently writes to the same tray icon state, with its own generic
(non-per-account) tooltip, sometimes several times in a row while folders
are still loading at startup. Rather than guessing a delay to write after
it, this add-on patches `MailNotificationManager._updateUnreadCount()`
directly so the per-account tooltip is re-applied right after each of its
native writes — cleanly undone on disable/uninstall/update.

**Thunderbird 159 compatibility:** in TB 159,
`nsIMessengerOSIntegration.updateUnreadCount()` gained a mandatory third
parameter (`imgIContainer badgeImgContainer`). This add-on detects the
supported signature at runtime (3-argument on TB 159+, 2-argument on
TB 154–158), so a single build works across both. Note that the badge image
parameter itself is irrelevant to the Windows tray icon: the red-dot badge
is Thunderbird's own built-in `IDI_MAILBIFF` resource icon, applied by the
native code whenever the unread count passed to `updateUnreadCount()` is
greater than zero.

**What changed natively in TB 159:** on Windows, Thunderbird's own unread
badge moved from the tray icon to a taskbar *overlay* — it is now drawn by
the new `SystemTrayBadgeManager.sys.mjs` module through
`WinUnreadBadge.sys.mjs` (`nsITaskbarOverlayIconController.setOverlayIcon()`),
and `MailNotificationManager` no longer calls the tray's
`updateUnreadCount()` on Windows at all. That makes this add-on the sole
writer of the tray icon's unread state on TB 159+. The native taskbar
overlay, however, is still fed by Thunderbird's own internal unread count,
which can get stuck and disagree with the count this add-on computes.

**Taskbar badge sync:** to keep the two indicators consistent, every state
push (and every re-assert after a native write) also repaints the taskbar
overlay through Thunderbird's own `WinUnreadBadge` module — on TB 159+ with
the same `SystemTrayBadgeManager` badge image the native code uses, on
TB 154–158 with that module's own built-in badge rendering. The native
`mail.biff.show_badge` pref is honored, and if the badge renderer module is
ever unavailable the overlay is left untouched rather than cleared. Redundant
pushes (same total and tooltip as the previous one) are skipped before they
can trigger another tray/overlay repaint, and the per-account unread walk
queries folders in parallel, tolerating a folder whose info momentarily
cannot be read (counted as 0 until the next folder-info event).

## Author

- **Author**: Bruno Eduardo, https://github.com/Hanatarou

## License

MIT — see [LICENSE](./LICENSE).
