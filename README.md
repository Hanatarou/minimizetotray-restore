# MinimizeToTray Restore

Restores the classic "minimize to tray" behavior that Thunderbird removed in
version 154, using the same native Windows OS integration API
(`nsIMessengerWindowsIntegration`) Thunderbird itself uses internally for its
"Close to Tray" feature.

**Windows only.** This relies on a Windows-specific native interface that
doesn't exist on Linux or macOS builds of Thunderbird — the add-on detects
the platform and does nothing on non-Windows systems.

## Why this exists

Starting with Thunderbird 154, Mozilla integrated the "Close to Tray"
add-on natively — but in doing so, removed the ability to minimize to tray
using the minimize button. See the
[Mozilla Connect discussion](https://connect.mozilla.org/t5/discussions/restore-minimize-to-tray-in-thunderbird/m-p/136129)
for context. This add-on restores that missing behavior.

## Features

- **Minimize to tray** — clicking the minimize button hides Thunderbird to
  the system tray instead of the taskbar.
- **Start minimized** (optional) — Thunderbird starts hidden in the tray,
  with no window flash from the second restart onward (see
  [How it works](#how-it-works)).
- **Optional native Close to Tray** — off by default, so the close (X)
  button keeps quitting Thunderbird as usual. Turn it on if you also want
  the X button to minimize to tray.
- Includes a workaround for a
  [Thunderbird core bug](#known-thunderbird-bug-worked-around) where the
  message pane / thread pane split resets when the window starts hidden.

## Installation

1. Download the latest `.xpi` from the
   [Releases](../../releases) page.
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

The add-on uses a
[WebExtension Experiment](https://webextension-api.thunderbird.net/en/latest/how-to/experiments.html)
to call `nsIMessengerWindowsIntegration.hideWindow()` — the same internal
service Thunderbird's own tray integration uses — after converting the
window to an `nsIBaseWindow` via its `docShell.treeOwner`.

For "start minimized" with zero flash, the add-on temporarily enables the
native `mail.closeToTray` / `mail.closeToTray.startInTray` prefs right
before Thunderbird quits (so Thunderbird's own start-in-tray logic, which
reads these prefs very early at the next boot, hides the window before it's
ever painted), then disables `mail.closeToTray` again once running, so the
close (X) button keeps its normal behavior unless you've explicitly enabled
"Also minimize to tray when closing".

### Known Thunderbird bug worked around

Thunderbird has a core bug (reproducible with 100% native settings, no
add-on involved) where the split between the thread pane and message pane
resets when the window starts hidden in the tray. This add-on snapshots the
thread pane's height whenever the window is hidden or closed, and restores
it live on the next startup.

## Author

- **Author**: Bruno Eduardo, https://github.com/Hanatarou

## License

MIT — see [LICENSE](./LICENSE).
