# MinimizeToTray Restore

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
