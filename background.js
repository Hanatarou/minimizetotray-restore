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
 * Sibling folders are queried in parallel — on accounts with many folders
 * this turns a long sequential round-trip chain into one batched wave,
 * which matters because this whole walk runs on every folder-info change.
 * A folder whose getFolderInfo() fails (e.g. momentarily detached IMAP
 * folder mid-startup) counts as 0 instead of failing the whole summary —
 * the next folder-info event will correct the total.
 *
 * @param {object} folder - A real MailFolder (not an account's root
 *   pseudo-folder — getFolderInfo() doesn't support those).
 * @returns {Promise<number>}
 */
async function sumFolderUnread(folder) {
  let unread = 0;
  try {
    const info = await browser.folders.getFolderInfo(folder.id);
    unread = info.unreadMessageCount || 0;
  } catch (ex) {
    console.warn(
      LOG_PREFIX,
      `getFolderInfo() failed for folder "${folder.name}" — counting it as 0.`,
      ex
    );
  }
  const subSums = await Promise.all(
    (folder.subFolders ?? []).map(sub => sumFolderUnread(sub))
  );
  return unread + subSums.reduce((sum, n) => sum + n, 0);
}

/**
 * Build the tray tooltip text: one line per account with unread messages,
 * e.g. "work: 3\npersonal: 12". Windows' native tooltip is capped around
 * ~127 characters, so this is naturally limited to accounts that actually
 * have something to show.
 *
 * Accounts are summed in parallel (each one's folder tree is summed in
 * parallel too, see sumFolderUnread), and the per-account lines are then
 * assembled in the original accounts order, so the tooltip text stays
 * deterministic despite the parallelism.
 */
async function buildUnreadSummary() {
  const accounts = await browser.accounts.list(true);
  const perAccount = await Promise.all(
    accounts.map(async account => {
      // account.rootFolder is a virtual container, not a real folder —
      // getFolderInfo() doesn't support it, so sum its real subfolders
      // (Inbox, Sent, etc.) instead.
      const folderSums = await Promise.all(
        (account.rootFolder.subFolders ?? []).map(folder =>
          sumFolderUnread(folder)
        )
      );
      const unread = folderSums.reduce((sum, n) => sum + n, 0);
      console.info(LOG_PREFIX, `Account "${account.name}": ${unread} unread.`);
      return { name: account.name, unread };
    })
  );

  const lines = [];
  let total = 0;
  for (const { name, unread } of perAccount) {
    if (unread > 0) {
      lines.push(`${name}: ${unread}`);
      total += unread;
    }
  }

  return {
    total,
    tooltip: lines.length ? lines.join("\n") : "No unread messages",
  };
}

/**
 * The last state actually pushed to the native side — used to skip
 * redundant updateTrayTooltip() round-trips. The ride-along scheduling
 * above means a push is attempted for *every* folder-info event, but the
 * vast majority of them end with the exact same total and tooltip (one
 * new message touches one folder; every other account's line is
 * unchanged). Each skipped push saves a full account/folder walk on the
 * native side of updateTrayTooltip() too, and — more importantly — a
 * redundant repaint of the tray icon and the taskbar overlay badge.
 * Starts out null, so after an extension (re)start the first push always
 * goes through and re-asserts the state.
 */
let lastPushedState = null; // { total, tooltip }

/**
 * Compute and push the tray tooltip (and taskbar badge) state.
 *
 * Pass { force: true } to bypass the "state unchanged" skip — used when
 * the push is reacting to an explicit user action (e.g. toggling the
 * tooltip option) rather than to a folder event.
 *
 * If the user has turned the custom tooltip text off, this still pushes our
 * own reliably-computed unread total (with an empty tooltip string, so
 * Thunderbird shows just its own generic "Thunderbird" line) instead of
 * leaving the badge to Thunderbird's own native unread-count tracking —
 * that tracking has been observed to get stuck / not reflect real unread
 * mail for some users, which would otherwise mean no badge at all while
 * this setting is off, even with genuine unread messages.
 */
async function pushTooltipNow({ force = false } = {}) {
  try {
    const { showTooltip } = await browser.storage.local.get({
      showTooltip: true,
    });
    const { total, tooltip } = await buildUnreadSummary();
    const tooltipToUse = showTooltip ? tooltip : "";

    if (
      !force &&
      lastPushedState &&
      lastPushedState.total === total &&
      lastPushedState.tooltip === tooltipToUse
    ) {
      console.info(
        LOG_PREFIX,
        `Unread state unchanged (total=${total}) — skipping redundant push.`
      );
      return;
    }

    lastPushedState = { total, tooltip: tooltipToUse };
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
 * (MailNotificationManager awaits WinUnreadBadge) finish first. Redundant
 * pushes that end up computing the exact same state are cheap now — they
 * are dropped by pushTooltipNow()'s unchanged-state check before reaching
 * the native side.
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
  // options page, instead of waiting for the next folder change. Forced,
  // since the toggle itself changes what should be pushed even when the
  // underlying unread counts didn't.
  browser.runtime.onMessage.addListener(message => {
    if (message?.type === "showTooltipChanged") {
      pushTooltipNow({ force: true });
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
