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

/**
 * Recursively sum the unread message count of a folder and all of its
 * subfolders (accounts.list(true) already populates the nested subFolders
 * tree, so this needs no extra API calls per folder besides getFolderInfo).
 * getFolderInfo() takes a folder id, not the full folder object.
 *
 * @param {object} folder - A real MailFolder (not an account's root
 *   pseudo-folder — getFolderInfo() doesn't support those).
 * @returns {Promise<number>}
 */
async function sumFolderUnread(folder) {
  const info = await browser.folders.getFolderInfo(folder.id);
  let sum = info.unreadMessageCount || 0;
  for (const sub of folder.subFolders ?? []) {
    sum += await sumFolderUnread(sub);
  }
  return sum;
}

/**
 * Build the tray tooltip text: one line per account with unread messages,
 * e.g. "work: 3\npersonal: 12". Windows' native tooltip is capped around
 * ~127 characters, so this is naturally limited to accounts that actually
 * have something to show.
 */
async function buildUnreadSummary() {
  const accounts = await browser.accounts.list(true);
  const lines = [];
  let total = 0;

  for (const account of accounts) {
    // account.rootFolder is a virtual container, not a real folder —
    // getFolderInfo() doesn't support it, so sum its real subfolders
    // (Inbox, Sent, etc.) instead.
    let unread = 0;
    for (const folder of account.rootFolder.subFolders ?? []) {
      unread += await sumFolderUnread(folder);
    }
    console.info(LOG_PREFIX, `Account "${account.name}": ${unread} unread.`);
    if (unread > 0) {
      lines.push(`${account.name}: ${unread}`);
      total += unread;
    }
  }

  return {
    total,
    tooltip: lines.length ? lines.join("\n") : "No unread messages",
  };
}

/**
 * Compute and push the tray tooltip immediately, with no debounce.
 *
 * If the user has turned the custom tooltip text off, this still pushes our
 * own reliably-computed unread total (with an empty tooltip string, so
 * Thunderbird shows just its own generic "Thunderbird" line) instead of
 * leaving the badge to Thunderbird's own native unread-count tracking —
 * that tracking has been observed to get stuck / not reflect real unread
 * mail for some users, which would otherwise mean no badge at all while
 * this setting is off, even with genuine unread messages.
 */
async function pushTooltipNow() {
  try {
    const { showTooltip } = await browser.storage.local.get({
      showTooltip: true,
    });
    const { total, tooltip } = await buildUnreadSummary();
    const tooltipToUse = showTooltip ? tooltip : "";
    console.info(
      LOG_PREFIX,
      `Pushing tray tooltip. Total: ${total}. Tooltip: ${JSON.stringify(tooltipToUse)}`
    );
    await browser.MinimizeToTray.updateTrayTooltip(total, tooltipToUse);
  } catch (ex) {
    console.error(LOG_PREFIX, "Failed to refresh tray tooltip.", ex);
  }
}

/**
 * Unlike a debounce (which cancels the previous pending push whenever a new
 * event arrives — meant to wait for things to go quiet), this schedules an
 * independent push for *every* trigger, none of them cancelling each other.
 * Thunderbird's own MailNotificationManager can recreate the tray icon many
 * times in a row while folders are still loading at startup (confirmed via
 * live API tracing); waiting for that churn to "go quiet" was a losing race
 * against unpredictable timing. Riding along with every single cycle instead
 * — including whichever one ends up being the last — means our tooltip
 * reliably lands right after each native update, the final one included.
 * The short delay just lets that cycle's own async chain
 * (MailNotificationManager awaits WinUnreadBadge) finish first.
 */
const RIDE_ALONG_DELAY_MS = 250;
function scheduleTooltipRefresh() {
  setTimeout(pushTooltipNow, RIDE_ALONG_DELAY_MS);
}

const { os } = await browser.runtime.getPlatformInfo();

if (os === "win") {
  // Work around the Thunderbird bug where hiding the window to tray around
  // startup can corrupt the persisted message pane layout. Run this before
  // anything else so the fix lands as early as possible.
  await browser.MinimizeToTray.restoreMessagePaneStateIfNeeded();

  await browser.MinimizeToTray.watch();

  // Keep the tray icon's tooltip showing unread counts per account, ridden
  // along with every native tray icon update (folder changes, taskbar
  // refresh) instead of waiting for things to settle — see
  // scheduleTooltipRefresh() for why.
  browser.folders.onFolderInfoChanged.addListener(scheduleTooltipRefresh);
  scheduleTooltipRefresh();

  // React immediately when the "show tooltip" checkbox is toggled in the
  // options page, instead of waiting for the next folder change.
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "showTooltipChanged") {
      pushTooltipNow();
    }
  });

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
