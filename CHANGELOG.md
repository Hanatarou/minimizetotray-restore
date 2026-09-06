# Changelog

## 1.1.0

- Clean up after yourself: disabling or uninstalling the add-on now resets
  `mail.closeToTray` and `mail.closeToTray.startInTray` back to their
  Thunderbird defaults, instead of leaving them stuck "on" as a residue of
  the add-on's own start-in-tray mechanism. A plain update (not a
  disable/uninstall) still keeps your settings, as expected.

## 1.0.0

Initial release.

- Restores minimize-to-tray via `nsIMessengerWindowsIntegration`, the same
  native Windows API Thunderbird's own "Close to Tray" uses internally.
- Optional "start minimized" setting, backed by the native
  `mail.closeToTray` / `mail.closeToTray.startInTray` prefs for a
  flash-free startup from the second restart onward.
- Optional, explicit opt-in for also enabling native Close to Tray during
  normal use (off by default — the close/X button keeps quitting
  Thunderbird as usual).
- Works around a Thunderbird core bug where the thread pane / message pane
  split resets when the window starts hidden in the tray, by snapshotting
  and restoring the thread pane's height.
