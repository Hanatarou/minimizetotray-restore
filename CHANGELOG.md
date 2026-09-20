# Changelog

## 1.2.0

- Added a tray icon tooltip showing unread message counts per account
  (one line per account with unread mail, e.g. "work: 3\npersonal: 12"),
  updated via the `folders.onFolderInfoChanged` event. Uses
  `nsIMessengerOSIntegration.updateUnreadCount()` — the same native
  mechanism Thunderbird's own tray icon uses. Requires the `accountsRead`
  permission.
- Fixed the tray icon/tooltip flashing on and then going dark right after
  "start minimized" boots. Root cause, confirmed via live Win32 API
  tracing and direct reading of Thunderbird's own source
  (`MailNotificationManager.sys.mjs`): Thunderbird's native
  `MailNotificationManager` independently writes to the same
  `nsIMessengerOSIntegration.updateUnreadCount()` this add-on uses, with
  its own generic (non-per-account) tooltip — and can do this several
  times in a row while folders are still loading at startup, silently
  overwriting our tooltip each time. Fixed by patching
  `MailNotificationManager._updateUnreadCount()` directly, so our tooltip
  is re-applied immediately after every single one of its native writes
  finishes — deterministically, regardless of how many times it runs. The
  patch is undone cleanly on disable/uninstall/update.

## 1.1.0

- Disabling or uninstalling the add-on now resets `mail.closeToTray` and
  `mail.closeToTray.startInTray` back to their Thunderbird defaults,
  instead of leaving them stuck "on". A plain update keeps existing
  settings.

## 1.0.0

Initial release.

- Restores minimize-to-tray via `nsIMessengerWindowsIntegration`, the same
  native Windows API Thunderbird's own "Close to Tray" uses internally.
- Optional "start minimized" setting, backed by the native
  `mail.closeToTray` / `mail.closeToTray.startInTray` prefs for a
  flash-free startup from the second restart onward.
- Optional, explicit opt-in for also enabling native Close to Tray during
  normal use (off by default).
- Works around a Thunderbird core bug where the thread pane / message pane
  split resets when the window starts hidden in the tray, by snapshotting
  and restoring the thread pane's height.
