/**
 * MinimizeToTray Restore — background script
 * ---------------------------------------------
 * Restores the "minimize to tray" behavior that Thunderbird removed in
 * version 154 (see https://connect.mozilla.org and the "Close to Tray"
 * add-on notes for context). Relies on nsIMessengerWindowsIntegration,
 * which only exists on Windows builds of Thunderbird — this add-on is a
 * no-op (by design) on Linux and macOS.
 */

const LOG_PREFIX = "MINIMIZETOTRAY-RESTORE:";

const { os } = await browser.runtime.getPlatformInfo();

if (os === "win") {
  // Work around the Thunderbird bug where hiding the window to tray around
  // startup can corrupt the persisted message pane layout. Run this before
  // anything else so the fix lands as early as possible.
  await browser.MinimizeToTray.restoreMessagePaneStateIfNeeded();

  await browser.MinimizeToTray.watch();

  const { startMinimized, enableCloseToTray } = await browser.storage.local.get({
    startMinimized: false,
    enableCloseToTray: false,
  });

  // Sync the native mail.closeToTray / mail.closeToTray.startInTray prefs
  // (see implementation.js for why this isn't just a straight pref set).
  await browser.MinimizeToTray.syncTraySettings(startMinimized, enableCloseToTray);

  if (startMinimized) {
    // Fallback in case the native prefs didn't have a chance to hide the
    // window yet (e.g. the very first time this is enabled, before
    // Thunderbird has restarted with the prefs already in place at boot).
    // If native start-in-tray already did its job, this is a harmless no-op.
    await browser.MinimizeToTray.startMinimized();
  }
} else {
  console.info(
    LOG_PREFIX,
    `Not running on Windows (detected: ${os}). TrayRestore has nothing to do here.`
  );
}
