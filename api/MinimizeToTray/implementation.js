const { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { AddonManager } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs"
);
const { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);
// `Services`, `Cc`, `Ci` and `Cr` are already available as globals in this
// privileged scope. Services.jsm / Services.sys.mjs was removed upstream —
// importing it manually throws and silently breaks the whole script.
// `setTimeout` is NOT a global here either (unlike in a WebExtension
// background page) — calling it unimported throws ReferenceError, silently
// swallowed inside an observer callback, which is why the delayed re-apply
// below never actually ran until this was fixed.

const ADDON_ID = "minimizetotray-restore@example.com";

const CLOSE_TO_TRAY_PREF = "mail.closeToTray";
const START_IN_TRAY_PREF = "mail.closeToTray.startInTray";
const WINDOW_TYPE_MAIL_3PANE = "mail:3pane";
const LOG_PREFIX = "MINIMIZETOTRAY-RESTORE:";

// --- nsIMessengerOSIntegration compatibility layer ---------------------
//
// The signature of nsIMessengerOSIntegration.updateUnreadCount() changed in
// Thunderbird 159 (mailnews/base/public/nsIMessengerOSIntegration.idl):
//
//   TB 154-158:  updateUnreadCount(unreadCount, unreadTooltip)
//   TB 159+:     updateUnreadCount(unreadCount, unreadTooltip, badgeImgContainer)
//
// badgeImgContainer (an imgIContainer) is a mandatory IDL parameter, so on
// TB 159+ a 2-argument call throws NS_ERROR_XPC_NOT_ENOUGH_ARGS — and on
// TB 154-158 a 3-argument call throws NS_ERROR_XPC_TOO_MANY_ARGS. Either
// failure was silent here (swallowed by the callers' try/catch), which is
// why the tray unread badge (red dot) and the per-account tooltip stopped
// working after Thunderbird 159: the native code only swaps the tray icon
// to its "new mail" variant (IDI_MAILBIFF) when sUnreadCount — which only
// updateUnreadCount() sets — is greater than zero.
//
// The Windows implementation ignores badgeImgContainer (see the comment on
// nsMessengerWinIntegration::UpdateUnreadCount in
// mailnews/base/src/nsMessengerWinIntegration.cpp — the red dot comes from
// a pre-built resource icon, not from this image), so passing `null` is
// correct and matches what Thunderbird's own MailNotificationManager does
// when its badge renderer can't produce an image.
//
// We detect which arity the running Thunderbird supports on the first call
// and remember it, so one build works on TB 154-158 AND TB 159+.

let osIntegrationService = null;
// null = not detected yet; true = 3-arg (TB 159+); false = 2-arg (TB 154-158).
let osIntegrationTakesBadgeImage = null;

function getOsIntegration() {
  if (!osIntegrationService) {
    osIntegrationService = Cc[
      "@mozilla.org/messenger/osintegration;1"
    ].getService(Ci.nsIMessengerOSIntegration);
  }
  return osIntegrationService;
}

/**
 * Push an unread count + tooltip to the tray icon, transparently handling
 * both the TB ≤ 158 (2-parameter) and TB 159+ (3-parameter) signatures of
 * nsIMessengerOSIntegration.updateUnreadCount().
 *
 * @param {number} unreadCount
 * @param {string} tooltip
 */
function pushUnreadCountToTray(unreadCount, tooltip) {
  const osIntegration = getOsIntegration();

  if (osIntegrationTakesBadgeImage !== false) {
    try {
      // TB 159+ signature. The image itself is irrelevant on Windows (the
      // native tray code ignores it), so null is fine.
      osIntegration.updateUnreadCount(unreadCount, tooltip, null);
      if (osIntegrationTakesBadgeImage === null) {
        console.info(
          LOG_PREFIX,
          "updateUnreadCount() accepted the 3-argument (TB 159+) signature."
        );
      }
      osIntegrationTakesBadgeImage = true;
      return;
    } catch (ex) {
      // Only the "too many arguments" error means we're on TB ≤ 158 and
      // must fall back to the legacy 2-argument form. Anything else is a
      // real failure and should surface to the caller.
      if (ex.result !== Cr.NS_ERROR_XPC_TOO_MANY_ARGS) {
        throw ex;
      }
      osIntegrationTakesBadgeImage = false;
      console.info(
        LOG_PREFIX,
        "updateUnreadCount() rejected the 3-argument form — using the legacy 2-argument signature (TB ≤ 158)."
      );
    }
  }

  // Legacy TB 154-158 signature.
  osIntegration.updateUnreadCount(unreadCount, tooltip);
}

// --- Windows taskbar overlay badge sync --------------------------------
//
// Since Thunderbird 159, on Windows, the native unread badge is drawn on
// the *taskbar* icon (nsITaskbarOverlayIconController.setOverlayIcon(),
// driven by mailnews/base/src/WinUnreadBadge.sys.mjs, with the numeric red
// badge image rendered by the new SystemTrayBadgeManager.sys.mjs) — and
// MailNotificationManager no longer writes the tray icon at all on Windows,
// which makes THIS add-on the sole writer of the tray's unread state.
//
// The native taskbar badge is still fed by Thunderbird's own internal
// unread count, which has been observed to get stuck and disagree with the
// count this add-on computes. To keep both indicators consistent, every
// push from the WebExtension side (and every re-assert after a native
// write) also repaints the taskbar overlay through Thunderbird's own
// WinUnreadBadge module — so the badge image, sizing and DPI handling stay
// pixel-identical to the native one, with zero drawing code duplicated
// here. WinUnreadBadge exists on every supported version (TB 154+); its
// 3-argument form (which takes the badge imgIContainer, TB 159+) is
// detected at runtime exactly like the tray call above, falling back to
// the 2-argument form (which renders its own badge internally) on TB
// 154-158.

const SHOW_BADGE_PREF = "mail.biff.show_badge";

let winUnreadBadgeModule = null;
// null = not detected yet; true = 3-arg (TB 159+); false = 2-arg (TB ≤ 158).
let winUnreadBadgeTakesImage = null;
// The overlay state we last painted, so identical repaints are skipped.
let lastTaskbarBadge = null; // { unreadCount, tooltip, showBadge }

function getWinUnreadBadge() {
  if (winUnreadBadgeModule === null) {
    try {
      winUnreadBadgeModule = ChromeUtils.importESModule(
        "resource:///modules/WinUnreadBadge.sys.mjs"
      ).WinUnreadBadge;
    } catch (ex) {
      winUnreadBadgeModule = false;
      console.error(
        LOG_PREFIX,
        "WinUnreadBadge.sys.mjs could not be imported — taskbar badge sync disabled.",
        ex
      );
    }
  }
  return winUnreadBadgeModule || null;
}

// SystemTrayBadgeManager only exists on TB 159+; on older versions the
// legacy 2-argument WinUnreadBadge call renders its own badge internally.
let systemTrayBadgeManager = null; // false = not available (TB ≤ 158).
function getBadgeImage(unreadCount) {
  if (systemTrayBadgeManager === null) {
    try {
      systemTrayBadgeManager = ChromeUtils.importESModule(
        "resource:///modules/SystemTrayBadgeManager.sys.mjs"
      ).SystemTrayBadgeManager;
    } catch (ex) {
      systemTrayBadgeManager = false;
    }
  }
  if (!systemTrayBadgeManager) {
    return null;
  }
  try {
    return systemTrayBadgeManager.getBadge(unreadCount);
  } catch (ex) {
    console.error(
      LOG_PREFIX,
      "SystemTrayBadgeManager.getBadge() failed — clearing/skipping the taskbar overlay image.",
      ex
    );
    return null;
  }
}

// Whether this Thunderbird is 159 or later (major version check, cached).
// TB 159+ is where the 3-argument WinUnreadBadge call (external badge image)
// and SystemTrayBadgeManager exist; on TB 154-158 the legacy 2-argument call
// renders its own badge internally, so a missing SystemTrayBadgeManager
// there is normal — not a "renderer unavailable" condition.
let isTB159Plus = null;
function getIsTB159Plus() {
  if (isTB159Plus === null) {
    const major = parseInt(Services.appinfo.version.split(".")[0], 10);
    isTB159Plus = Number.isFinite(major) && major >= 159;
  }
  return isTB159Plus;
}

/**
 * Repaint the Windows taskbar overlay badge with our own unread count and
 * tooltip, so the taskbar icon can't disagree with the tray icon.
 *
 * Honors Thunderbird's native mail.biff.show_badge pref (the same gate the
 * native taskbar path uses): with the pref off, the overlay is cleared.
 *
 * @param {number} unreadCount
 * @param {string} tooltip
 * @param {boolean} [force] - Skip the "state unchanged" dedupe. Used by the
 *   MailNotificationManager hook, which runs right after Thunderbird's own
 *   badge write: even when the state we want looks identical to what we
 *   pushed last time, the native write in between may have clobbered the
 *   overlay (its own count and generic tooltip), so it must be repainted.
 */
async function pushBadgeToTaskbar(unreadCount, tooltip, force = false) {
  // Mirror the native behavior for mail.biff.show_badge (on TB ≤ 158 the
  // native caller zeroed the count before WinUnreadBadge; on TB 159+
  // WinUnreadBadge checks the pref itself — doing it here covers both).
  const showBadge = Services.prefs.getBoolPref(SHOW_BADGE_PREF, true);
  const effectiveCount = showBadge ? Math.max(unreadCount, 0) : 0;
  const effectiveTooltip = effectiveCount > 0 ? tooltip : "";

  if (
    !force &&
    lastTaskbarBadge &&
    lastTaskbarBadge.unreadCount === effectiveCount &&
    lastTaskbarBadge.tooltip === effectiveTooltip &&
    lastTaskbarBadge.showBadge === showBadge
  ) {
    return;
  }

  const winUnreadBadge = getWinUnreadBadge();
  if (
    !winUnreadBadge ||
    typeof winUnreadBadge.updateUnreadCount !== "function"
  ) {
    return;
  }

  try {
    if (winUnreadBadgeTakesImage !== false) {
      // TB 159+ signature. The badge image comes from Thunderbird's own
      // SystemTrayBadgeManager (same renderer the native badge uses).
      const img = effectiveCount > 0 ? getBadgeImage(effectiveCount) : null;
      if (
        effectiveCount > 0 &&
        img === null &&
        systemTrayBadgeManager === false &&
        getIsTB159Plus()
      ) {
        // The renderer module is unavailable on this TB 159+ build — leave
        // the overlay untouched instead of passing null, which would CLEAR
        // a badge the native code may have drawn correctly. On TB 154-158 a
        // missing SystemTrayBadgeManager is normal (it doesn't exist there):
        // the legacy 2-argument call below renders its own badge, so this
        // guard is gated on the version and must not fire there — otherwise
        // every positive-count push would be swallowed and the legacy
        // fallback never reached.
        return;
      }
      try {
        // A null image with a positive count clears the overlay — the same
        // thing the native code does when its own badge renderer can't
        // produce an image (e.g. no window to draw in), so this mirrors
        // native behavior.
        await winUnreadBadge.updateUnreadCount(
          effectiveCount,
          effectiveTooltip,
          img
        );
        if (winUnreadBadgeTakesImage === null) {
          console.info(
            LOG_PREFIX,
            "WinUnreadBadge.updateUnreadCount() accepted the 3-argument (TB 159+) signature."
          );
        }
        winUnreadBadgeTakesImage = true;
      } catch (ex) {
        // Only "too many arguments" means we're on TB ≤ 158 and must fall
        // back to the legacy 2-argument form. Anything else is a real
        // failure and is logged by the outer catch.
        if (ex.result !== Cr.NS_ERROR_XPC_TOO_MANY_ARGS) {
          throw ex;
        }
        winUnreadBadgeTakesImage = false;
        console.info(
          LOG_PREFIX,
          "WinUnreadBadge.updateUnreadCount() rejected the 3-argument form — using the legacy 2-argument signature (TB ≤ 158)."
        );
      }
    }
    if (winUnreadBadgeTakesImage === false) {
      // Legacy TB 154-158 signature: WinUnreadBadge draws its own badge.
      await winUnreadBadge.updateUnreadCount(effectiveCount, effectiveTooltip);
    }
    lastTaskbarBadge = {
      unreadCount: effectiveCount,
      tooltip: effectiveTooltip,
      showBadge,
    };
  } catch (ex) {
    console.error(LOG_PREFIX, "Failed to update the taskbar badge.", ex);
  }
}

// --- Message pane layout workaround -----------------------------------
//
// Thunderbird has a bug (reproducible even with 100% native settings, no
// add-on involved) where the split between the thread pane (message list)
// and the message pane gets reset when the window is hidden to tray around
// startup — presumably because the layout gets calculated/saved while the
// window has no real (or zeroed) dimensions.
//
// In the classic/wide layout, the draggable dimension is the *thread pane's*
// explicit inline height (e.g. `#threadPane { height: 162px !important }`
// in about3Pane's document) — the message pane simply fills whatever space
// is left. This block snapshots that height whenever *we* hide the window
// (while it's still in a normal, trustworthy state) and re-applies it live
// on the next startup if it looks like it changed.
const THREAD_PANE_ID = "threadPane";
const PANE_SNAPSHOT_PREF = "extensions.minimizetotray-restore.paneSnapshot";

/**
 * @param {Window} win - A mail:3pane chrome window.
 * @returns {Element|null} The #threadPane element inside the currently
 *   selected about3Pane tab, or null if it can't be found.
 */
function getThreadPaneElement(win) {
  try {
    return win?.gTabmail?.currentAbout3Pane?.document?.getElementById(
      THREAD_PANE_ID
    ) ?? null;
  } catch (ex) {
    return null;
  }
}

/**
 * Snapshot the thread pane's current inline height, so it can be restored
 * later if Thunderbird's own tray-related code resets it.
 *
 * @param {Window} win
 */
function captureMessagePaneState(win) {
  try {
    const el = getThreadPaneElement(win);
    const height = el?.style.height;
    if (height) {
      Services.prefs.setStringPref(PANE_SNAPSHOT_PREF, height);
      console.info(LOG_PREFIX, "Captured thread pane height:", height);
    }
  } catch (ex) {
    console.error(LOG_PREFIX, "Failed to capture thread pane height.", ex);
  }
}

/**
 * Compare the current #threadPane height against the last known-good
 * snapshot, and re-apply it (live, with !important, matching how
 * Thunderbird itself sets it) if they differ.
 */
function restoreMessagePaneStateIfNeeded() {
  const height = Services.prefs.getStringPref(PANE_SNAPSHOT_PREF, "");
  if (!height) {
    return; // Nothing captured yet.
  }

  try {
    const win = Services.wm.getMostRecentWindow(WINDOW_TYPE_MAIL_3PANE);
    const el = getThreadPaneElement(win);
    if (!el) {
      console.info(
        LOG_PREFIX,
        "Could not find #threadPane to check/restore its height."
      );
      return;
    }

    if (el.style.height === height) {
      return; // Already matches, nothing to fix.
    }

    console.info(
      LOG_PREFIX,
      "Thread pane height looks wrong, restoring.",
      "Was:",
      el.style.height,
      "Restoring to:",
      height
    );
    el.style.setProperty("height", height, "important");
  } catch (ex) {
    console.error(LOG_PREFIX, "Failed to restore thread pane height.", ex);
  }
}

/**
 * The last unread state pushed by the WebExtension side via
 * updateTrayTooltip(). Re-applied every time we hide the window, and right
 * after Thunderbird's own MailNotificationManager finishes its own badge
 * write (see installMailNotificationHook below) — both of which can
 * otherwise leave our custom per-account tooltip overwritten by its
 * generic one, or the taskbar badge showing a count other than ours.
 */
let cachedTooltip = null;

/**
 * Thunderbird's native MailNotificationManager
 * (mailnews/base/src/MailNotificationManager.sys.mjs) independently writes
 * to the same nsIMessengerOSIntegration.updateUnreadCount() we do — with
 * its own generic tooltip, no per-account breakdown — in reaction to
 * folder changes and to the Windows "TaskbarCreated" broadcast (relayed as
 * the "refresh-badge-tray" observer topic, renamed from
 * "windows-refresh-badge-tray" in TB 159). Confirmed via live API
 * tracing that it can do this several times in a row right at startup
 * while folders are still loading, each one able to silently overwrite our
 * own write. Guessing a fixed delay to write after it never proved
 * reliable, since its own update is async (it awaits
 * WinUnreadBadge.updateUnreadCount() first) with no fixed duration.
 *
 * Since TB 159 on Windows its write goes through WinUnreadBadge (the
 * taskbar overlay) and no longer touches the tray icon — but it still
 * lands *after* ours in those paths, with its own count and tooltip, so
 * both indicators can still be clobbered.
 *
 * Instead of guessing, this patches MailNotificationManager's own
 * _updateUnreadCount() method (a plain, non-private instance method) so our
 * state is re-applied immediately after every single one of its native
 * writes finishes — deterministically, with no timing assumption, no
 * matter how many times it runs or how long each run takes. Both the tray
 * icon and the taskbar overlay are re-asserted (the latter with force,
 * bypassing the dedupe, precisely because the native write in between may
 * have clobbered the overlay even when our own state didn't change).
 */
let mailNotificationHookInstalled = false;
let mailNotificationManagerRef = null;
let originalUpdateUnreadCount = null;
function installMailNotificationHook() {
  if (mailNotificationHookInstalled) {
    return;
  }
  try {
    const { MailNotificationManager } = ChromeUtils.importESModule(
      "resource:///modules/MailNotificationManager.sys.mjs"
    );
    mailNotificationManagerRef = MailNotificationManager;
    // Guard against future Thunderbird refactors: if the method we patch is
    // ever renamed or removed (e.g. turned into an ES private #method), fail
    // visibly in the log and skip the hook instead of throwing here.
    if (typeof MailNotificationManager._updateUnreadCount !== "function") {
      console.error(
        LOG_PREFIX,
        "MailNotificationManager._updateUnreadCount() not found — internal API changed in this Thunderbird version; skipping the tooltip-reapply hook."
      );
      return;
    }
    originalUpdateUnreadCount =
      MailNotificationManager._updateUnreadCount.bind(MailNotificationManager);
    MailNotificationManager._updateUnreadCount = async function (...args) {
      const result = await originalUpdateUnreadCount(...args);
      if (cachedTooltip) {
        try {
          pushUnreadCountToTray(
            cachedTooltip.unreadCount,
            cachedTooltip.tooltip
          );
          // force = the native write in between may have repainted the
          // overlay with its own (possibly stuck) count and generic
          // tooltip, even when our own state didn't change.
          await pushBadgeToTaskbar(
            cachedTooltip.unreadCount,
            cachedTooltip.tooltip,
            true
          );
          console.info(
            LOG_PREFIX,
            "Reapplied cached tray tooltip and taskbar badge right after MailNotificationManager's own write."
          );
        } catch (ex) {
          console.error(LOG_PREFIX, "Failed to reapply badge state.", ex);
        }
      }
      return result;
    };
    mailNotificationHookInstalled = true;
    console.info(LOG_PREFIX, "Hooked MailNotificationManager._updateUnreadCount.");
  } catch (ex) {
    console.error(
      LOG_PREFIX,
      "Failed to hook MailNotificationManager — falling back to no reapply on its writes.",
      ex
    );
  }
}

/**
 * Restore MailNotificationManager's original method, so this add-on leaves
 * no trace in another module's object once it's disabled/uninstalled/updated.
 */
function uninstallMailNotificationHook() {
  if (!mailNotificationHookInstalled) {
    return;
  }
  // Remove the patched method entirely so the prototype's original becomes
  // active again — assigning the bound original back would leave an own
  // property behind on the singleton (a subtle trace in another module's
  // object).
  delete mailNotificationManagerRef._updateUnreadCount;
  mailNotificationHookInstalled = false;
  mailNotificationManagerRef = null;
  originalUpdateUnreadCount = null;
}

/**
 * Current tray settings, as last pushed by the WebExtension side via
 * syncTraySettings(). Lives for the lifetime of the add-on process; there's
 * no need to persist it here since the WebExtension's own browser.storage
 * is the source of truth — this is just a cache for the shutdown handler.
 */
let traySettings = { startMinimized: false, enableCloseToTray: false };
let shutdownHandlerRegistered = false;
let shutdownObserver = null;

/**
 * Register a one-time-per-session observer that runs right before
 * Thunderbird quits.
 *
 * It always captures the current thread pane height first — the user may
 * have adjusted the splitter and then quit directly via the close (X)
 * button or File > Quit, without ever minimizing to tray again, in which
 * case hideWindowToTray()'s capture would otherwise never see that change.
 *
 * If the user wants "start minimized" without also wanting native Close to
 * Tray during normal use, mail.closeToTray is then also turned back on at
 * this point — so Thunderbird's own start-in-tray logic (which reads these
 * prefs once, very early at the next boot, long before this add-on gets a
 * chance to run) sees it as enabled and hides the window with zero flash.
 * syncTraySettings() turns it back off again once the add-on starts up in
 * that next session.
 */
function registerShutdownHandler() {
  if (shutdownHandlerRegistered) {
    return;
  }
  shutdownHandlerRegistered = true;

  shutdownObserver = {
    observe() {
      const win = Services.wm.getMostRecentWindow(WINDOW_TYPE_MAIL_3PANE);
      if (win) {
        captureMessagePaneState(win);
      }

      if (traySettings.startMinimized && !traySettings.enableCloseToTray) {
        Services.prefs.setBoolPref(CLOSE_TO_TRAY_PREF, true);
      }
    },
  };
  Services.obs.addObserver(shutdownObserver, "quit-application-granted");
}

/**
 * Reset every native pref this add-on may have touched, back to their
 * Thunderbird defaults (unset). Called when the add-on is disabled or
 * uninstalled, so nothing is left behind — e.g. mail.closeToTray staying
 * stuck "on" from the start-in-tray pref dance, with no add-on left
 * around to ever turn it back off.
 */
function resetNativeTrayPrefs() {
  Services.prefs.clearUserPref(CLOSE_TO_TRAY_PREF);
  Services.prefs.clearUserPref(START_IN_TRAY_PREF);
  Services.prefs.clearUserPref(PANE_SNAPSHOT_PREF);
  console.info(
    LOG_PREFIX,
    "Add-on disabled or uninstalled — reset native tray prefs to defaults."
  );
}

/**
 * Listens for this specific add-on being disabled or uninstalled (as
 * opposed to updated, which also tears down the old version but should NOT
 * reset the user's settings) and cleans up native prefs at that point.
 */
const addonLifecycleListener = {
  onDisabling(addon) {
    if (addon.id === ADDON_ID) {
      resetNativeTrayPrefs();
    }
  },
  onUninstalling(addon) {
    if (addon.id === ADDON_ID) {
      resetNativeTrayPrefs();
    }
  },
};

let addonListenerRegistered = false;
function registerAddonLifecycleListener() {
  if (addonListenerRegistered) {
    return;
  }
  addonListenerRegistered = true;
  AddonManager.addAddonListener(addonLifecycleListener);
}

/**
 * Hide a mail:3pane window to the Windows system tray.
 *
 * This relies on nsIMessengerWindowsIntegration, the same native service
 * Thunderbird's own "Close to Tray" feature uses internally. Its hideWindow()
 * method expects an nsIBaseWindow — not the DOM/chrome window itself — so the
 * window must be converted via its docShell tree owner first.
 *
 * @param {Window} win - The chrome window to hide.
 */
function hideWindowToTray(win) {
  captureMessagePaneState(win);
  try {
    const baseWindow = win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow);
    const osIntegration = Cc["@mozilla.org/messenger/osintegration;1"].getService(
      Ci.nsIMessengerWindowsIntegration
    );
    osIntegration.hideWindow(baseWindow);
    console.info(LOG_PREFIX, "Window hidden to tray.");

    // hideWindow() appears to (re)create the tray icon with the default
    // "Thunderbird" tooltip, wiping out whatever custom tooltip we'd set —
    // reassert it right away instead of waiting for the next folder change.
    if (cachedTooltip) {
      pushUnreadCountToTray(cachedTooltip.unreadCount, cachedTooltip.tooltip);
      console.info(LOG_PREFIX, "Reapplied cached tooltip after hiding.");
    } else {
      console.info(LOG_PREFIX, "No cached tooltip yet to reapply.");
    }
  } catch (ex) {
    console.error(LOG_PREFIX, "Failed to hide window to tray.", ex);
  }
}

/**
 * Per-window listeners attached by watchWindow(), keyed by window, so they
 * can be removed again on add-on shutdown (disable/update) — a disabled
 * add-on must not keep zombie listeners hiding windows to the tray, and an
 * update must not leave duplicate observers behind. WeakMap, so windows
 * that close are still garbage-collected normally.
 */
const watchedWindows = new WeakMap();

/**
 * Attach "sizemodechange" and "close" listeners to `win`, hiding it to the
 * tray whenever it gets minimized. Safe to call more than once per window.
 *
 * @param {Window} win
 */
function watchWindow(win) {
  if (watchedWindows.has(win)) {
    return;
  }

  const handlers = {
    onSizeModeChange: () => {
      if (win.windowState === win.STATE_MINIMIZED) {
        if (isAlreadyHiddenToTray(win)) {
          console.info(
            LOG_PREFIX,
            "Already hidden — skipping redundant sizemodechange hide."
          );
          return;
        }
        console.info(LOG_PREFIX, "Minimize detected, hiding window.");
        hideWindowToTray(win);
      }
    },
    // Capture the pane height whenever the window is about to close — this
    // fires synchronously on the window itself (unlike quit-application-
    // granted, which may arrive after the extension's own context has
    // already started tearing down), and fires whether the window ends up
    // actually closing or being redirected to the tray by native
    // Close to Tray (preventDefault() elsewhere doesn't stop this listener
    // from running).
    onClose: () => {
      captureMessagePaneState(win);
    },
  };

  watchedWindows.set(win, handlers);
  win.addEventListener("sizemodechange", handlers.onSizeModeChange);
  win.addEventListener("close", handlers.onClose);
}

/**
 * Remove the listeners attached by watchWindow() from every still-open
 * watched window. Windows that were closed already are gone from the
 * window manager (and their WeakMap entry with them).
 */
function unwatchAllWindows() {
  for (const win of Services.wm.getEnumerator(WINDOW_TYPE_MAIL_3PANE)) {
    const handlers = watchedWindows.get(win);
    if (handlers) {
      win.removeEventListener("sizemodechange", handlers.onSizeModeChange);
      win.removeEventListener("close", handlers.onClose);
      watchedWindows.delete(win);
    }
  }
}

/** The "domwindowopened" observer added by watchAllWindows() — kept in a
 * module variable so onShutdown() can remove it again. */
let newWindowObserver = null;

/**
 * Start watching every currently open mail:3pane window, and any that open
 * afterwards, for minimize events.
 */
function watchAllWindows() {
  for (const win of Services.wm.getEnumerator(WINDOW_TYPE_MAIL_3PANE)) {
    watchWindow(win);
  }

  newWindowObserver = {
    observe(subject) {
      const windowType =
        subject.document?.documentElement?.getAttribute("windowtype");
      if (windowType === WINDOW_TYPE_MAIL_3PANE) {
        subject.addEventListener("load", () => watchWindow(subject), {
          once: true,
        });
      }
    },
  };
  Services.obs.addObserver(newWindowObserver, "domwindowopened");

  console.info(LOG_PREFIX, "Observers installed.");
}

/**
 * Whether `win` has already been hidden to the tray (e.g. by Thunderbird's
 * own native start-in-tray, which may have already run before this add-on
 * got a chance to do anything).
 *
 * @param {Window} win
 * @returns {boolean}
 */
function isAlreadyHiddenToTray(win) {
  try {
    const baseWindow = win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow);
    return baseWindow.visibility === false;
  } catch (ex) {
    return false;
  }
}

/**
 * Hide `win` to the tray as part of startup, avoiding any visible flash.
 *
 * If the window has already finished loading (e.g. the background script
 * started after Thunderbird had already finished opening it), there's
 * nothing earlier left to hook into — hide it immediately, unless it has
 * already been hidden (most likely by Thunderbird's own native start-in-tray,
 * once the prefs from syncTraySettings() have taken effect on a prior
 * shutdown). Calling hideWindow() a second, redundant time on the same
 * window has been observed to disrupt persisted pane-layout state (e.g. the
 * message pane splitter position not being saved correctly), so this check
 * matters, not just for tidiness.
 *
 * Otherwise, hide it on "MozBeforeInitialXULLayout" — the same internal
 * event Thunderbird's own "start in tray" (mail.closeToTray.startInTray)
 * hooks into (see messenger.xhtml) — which fires before the window's
 * initial layout is painted. Hiding at that point means the window is
 * never actually shown on screen. A "load" listener is kept as a safety
 * net in case that event doesn't fire for some reason.
 *
 * @param {Window} win
 */
function hideOnStartup(win) {
  if (win.document.readyState === "complete") {
    if (isAlreadyHiddenToTray(win)) {
      console.info(
        LOG_PREFIX,
        "Window already hidden (native start-in-tray got there first) — skipping redundant hide."
      );
      return;
    }
    hideWindowToTray(win);
    return;
  }

  let done = false;
  const hideOnce = () => {
    if (done) {
      return;
    }
    done = true;
    if (isAlreadyHiddenToTray(win)) {
      console.info(
        LOG_PREFIX,
        "Window already hidden (native start-in-tray got there first) — skipping redundant hide."
      );
      return;
    }
    hideWindowToTray(win);
  };

  win.addEventListener("MozBeforeInitialXULLayout", hideOnce, { once: true });
  win.addEventListener("load", hideOnce, { once: true }); // safety net
}

/** The one-shot "domwindowopened" observer from watchStartup() — kept in a
 * module variable so onShutdown() can remove it if it never fired. */
let startupWindowObserver = null;

/**
 * Hide the main window to the tray at startup: the current mail:3pane
 * window if one already exists, or the next one to open otherwise (the
 * background script may run before or after the window is created,
 * depending on startup timing).
 */
function watchStartup() {
  const alreadyOpen = [...Services.wm.getEnumerator(WINDOW_TYPE_MAIL_3PANE)];
  if (alreadyOpen.length) {
    alreadyOpen.forEach(hideOnStartup);
    return;
  }

  startupWindowObserver = {
    observe(subject) {
      const windowType =
        subject.document?.documentElement?.getAttribute("windowtype");
      if (windowType === WINDOW_TYPE_MAIL_3PANE) {
        Services.obs.removeObserver(startupWindowObserver, "domwindowopened");
        startupWindowObserver = null;
        hideOnStartup(subject);
      }
    },
  };
  Services.obs.addObserver(startupWindowObserver, "domwindowopened");
}

var MinimizeToTray = class extends ExtensionCommon.ExtensionAPI {
  getAPI() {
    return {
      MinimizeToTray: {
        async watch() {
          watchAllWindows();
        },
        async startMinimized() {
          watchStartup();
        },
        async syncTraySettings(startMinimized, enableCloseToTray) {
          traySettings = { startMinimized, enableCloseToTray };
          registerShutdownHandler();
          registerAddonLifecycleListener();
          installMailNotificationHook();

          if (enableCloseToTray) {
            // The user wants native Close to Tray to actually engage during
            // normal use too — leave it on persistently.
            Services.prefs.setBoolPref(CLOSE_TO_TRAY_PREF, true);
          } else {
            // Only needed momentarily at boot (handled by the shutdown
            // handler above); keep it off while running so the close (X)
            // button behaves normally.
            Services.prefs.setBoolPref(CLOSE_TO_TRAY_PREF, false);
          }
          Services.prefs.setBoolPref(START_IN_TRAY_PREF, startMinimized);

          console.info(LOG_PREFIX, "Tray settings synced:", {
            startMinimized,
            enableCloseToTray,
          });
        },
        async restoreMessagePaneStateIfNeeded() {
          restoreMessagePaneStateIfNeeded();
        },
        async updateTrayTooltip(unreadCount, tooltip) {
          cachedTooltip = { unreadCount, tooltip };
          try {
            pushUnreadCountToTray(unreadCount, tooltip);
            console.info(
              LOG_PREFIX,
              `updateUnreadCount() called natively with count=${unreadCount}.`
            );
          } catch (ex) {
            console.error(LOG_PREFIX, "Failed to update tray tooltip.", ex);
          }
          // Keep the Windows taskbar overlay badge in sync with the same
          // count (fire-and-forget: it does its own error handling and
          // must never make the tray push above look failed).
          pushBadgeToTaskbar(unreadCount, tooltip);
        },
      },
    };
  }

  /**
   * Called when this add-on is shutting down, whether because Thunderbird
   * itself is quitting, or because the add-on is being disabled, updated,
   * or uninstalled — isAppShutdown only distinguishes the first case from
   * the rest. Actual pref cleanup for disable/uninstall (as opposed to a
   * plain update, which should keep the user's settings) already happened
   * in addonLifecycleListener above; this just removes the listeners this
   * script registered, so they don't linger after its scope is gone.
   */
  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }
    if (addonListenerRegistered) {
      AddonManager.removeAddonListener(addonLifecycleListener);
      addonListenerRegistered = false;
    }
    if (shutdownObserver) {
      Services.obs.removeObserver(shutdownObserver, "quit-application-granted");
      shutdownObserver = null;
      shutdownHandlerRegistered = false;
    }
    if (newWindowObserver) {
      Services.obs.removeObserver(newWindowObserver, "domwindowopened");
      newWindowObserver = null;
    }
    if (startupWindowObserver) {
      Services.obs.removeObserver(startupWindowObserver, "domwindowopened");
      startupWindowObserver = null;
    }
    uninstallMailNotificationHook();
    unwatchAllWindows();
  }
};
