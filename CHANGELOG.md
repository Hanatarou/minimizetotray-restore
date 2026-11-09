# Changelog

## 1.3.3

- **The tray state is no longer marked as pushed before the native write
  actually happens.** In `pushTooltipNow()`, `lastPushedState` was assigned
  before `await browser.MinimizeToTray.updateTrayTooltip()`. If that call
  rejected (e.g. the experiment context died mid-write), the state was
  already recorded as pushed, so subsequent pushes with the same unread
  state were silently skipped as "unchanged" — leaving a stale tray badge
  and tooltip until the next folder change happened to alter the state. The
  state is now recorded only after the write resolves, so the next folder
  event retries the identical push instead.
- **The message pane layout workaround now covers every open mail window.**
  `restoreMessagePaneStateIfNeeded()` compared and restored only the most
  recent `mail:3pane` window, so with multiple Thunderbird windows open the
  others kept a reset thread pane / message pane split. Thunderbird itself
  persists the splitter size once, in the XUL store, keyed by the
  `messenger.xhtml` document — one shared height across all mail windows
  and tabs (`PaneLayout` in `pane-layout.mjs`) — so the single-snapshot
  model was already correct; the restore just has to walk every open
  window, which it now does, with a per-window check and a summary log
  line.

## 1.3.2

- **Fixed the taskbar badge sync never painting on Thunderbird 154–158 while
  unread messages exist.** The "badge renderer unavailable → leave the
  overlay untouched" guard in `pushBadgeToTaskbar()` compared only against
  `SystemTrayBadgeManager`, which doesn't exist on TB 154–158 by design — so
  the guard fired there too, swallowing every positive-count push before the
  legacy 2-argument `WinUnreadBadge.updateUnreadCount()` call (which renders
  its own badge internally) could ever run. The taskbar badge only started
  following this add-on's count after the first zero-count push happened to
  run the signature detection, if that ever happened at all. The guard is now
  gated on the Thunderbird version (cached `Services.appinfo` major check):
  only TB 159+ — where the 3-argument call really depends on the external
  renderer — leaves the overlay untouched when the renderer is missing; on
  TB 154–158 the legacy fallback is reached immediately, as documented.
- **Full teardown of window watchers and observers on disable/update.**
  `onShutdown()` removed the add-on listener, the shutdown observer and the
  `MailNotificationManager` hook, but the `domwindowopened` observer from
  `watchAllWindows()` (and the one-shot one from `watchStartup()`, if it had
  not fired yet) and the per-window `sizemodechange`/`close` listeners were
  left behind: after disabling, zombie listeners kept hiding windows to the
  tray on minimize, and after an update the old and new observers piled up.
  All of them are now tracked (per-window handlers in a `WeakMap`, observers
  in module variables) and removed on shutdown.

## 1.3.1

- **Fixed the tray icon unread badge (red dot) and tooltip disappearing after
  Thunderbird 159.** Thunderbird 159 added a mandatory third parameter
  (`imgIContainer badgeImgContainer`) to
  `nsIMessengerOSIntegration.updateUnreadCount()`
  (mailnews/base/public/nsIMessengerOSIntegration.idl). Every 2-argument call
  this add-on made started throwing `NS_ERROR_XPC_NOT_ENOUGH_ARGS`, silently
  swallowed by the callers' try/catch — leaving Thunderbird's own (less
  reliable) native count tracking as the only writer of the tray badge state.
  The call is now signature-detected at runtime: the 3-argument form is used
  on Thunderbird 159+ (passing `null` — the Windows implementation ignores
  the image and switches to its built-in `IDI_MAILBIFF` "new mail" icon
  whenever the count is greater than zero), with an automatic fallback to the
  legacy 2-argument form on Thunderbird 154–158. One build now works across
  all supported Thunderbird versions.
- **The taskbar icon's unread badge now follows this add-on's own count.**
  Thunderbird 159 moved the native Windows unread badge to a taskbar
  *overlay* (drawn by the new `SystemTrayBadgeManager` through
  `WinUnreadBadge`), and `MailNotificationManager` no longer writes the
  tray icon on Windows at all — making this add-on the sole writer of the
  tray's unread state there. The native taskbar overlay, however, is still
  fed by Thunderbird's own internal count, which can get stuck and disagree
  with the count this add-on computes. Every push now also repaints the
  taskbar overlay through Thunderbird's own `WinUnreadBadge` module (so the
  badge image, sizing and DPI handling remain pixel-identical to the native
  one), with the count and tooltip this add-on computed. Honors the native
  `mail.biff.show_badge` pref, works on TB 154–158 (2-argument legacy
  signature) and TB 159+ (3-argument signature with the badge image), and
  is skipped — never cleared — if the badge renderer module is unavailable.
- **Unread-count walks are now parallel and fault-tolerant.**
  `sumFolderUnread()` / `buildUnreadSummary()` previously walked every
  folder sequentially (one `getFolderInfo()` round-trip at a time) and a
  single failing folder (e.g. a momentarily detached IMAP folder at
  startup) aborted the whole push. Sibling folders and accounts are now
  queried in parallel (per-account tooltip lines keep their original
  order), and a failing folder counts as 0 for that pass — the next
  folder-info event corrects the total.
- **Redundant tray pushes are now skipped.** The ride-along scheduling
  intentionally attempts a push for every folder-info event; pushes that
  end up computing the exact same total and tooltip are now dropped before
  reaching the native side, avoiding a redundant tray-icon and taskbar
  overlay repaint per event. Explicit user actions (e.g. toggling the
  tooltip option) still push immediately and unconditionally.
- The `MailNotificationManager` hook now re-asserts **both** the tray icon
  and the taskbar overlay after each native write (the native write in
  between can repaint the overlay with Thunderbird's own count and generic
  tooltip, even when our state didn't change), and its documentation now
  reflects the TB 159 rename of the `windows-refresh-badge-tray` observer
  topic to `refresh-badge-tray`.
- Hardened the same `MailNotificationManager` hook: it now skips cleanly
  (with a clear log message) if the internal method it patches is ever
  renamed or removed by a future Thunderbird version, and it restores the
  original method via `delete` (instead of reassigning the bound original,
  which left a lingering own property on the singleton) when the add-on
  shuts down.
- Cached the OS integration XPCOM service instead of re-resolving it on
  every tray update.

## 1.3.0

- Added a checkbox to turn the tray tooltip's custom per-account text on/off
  (Options → Tray icon), taking effect immediately in both directions —
  turning it off shows Thunderbird's plain default tooltip line right
  away, and turning it on shows the per-account breakdown right away. In
  both cases, the tray icon's unread badge keeps using this add-on's own
  reliably-computed count, rather than falling back to Thunderbird's own
  native unread-count tracking (observed to not reliably reflect real
  unread counts for some users) when the custom text is off.
- Added localization for 15 languages (English, Portuguese (Brazil),
  Spanish, French, German, Russian, Chinese (Simplified), Hindi, Arabic,
  Bengali, Urdu, Indonesian, Japanese, Swahili, Turkish) — follows
  Thunderbird's own UI language automatically, with English as fallback.

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
