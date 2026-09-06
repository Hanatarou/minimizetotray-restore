const { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
// `Services`, `Cc`, `Ci` and `Cr` are already available as globals in this
// privileged scope. Services.jsm / Services.sys.mjs was removed upstream —
// importing it manually throws and silently breaks the whole script.

const CLOSE_TO_TRAY_PREF = "mail.closeToTray";
const START_IN_TRAY_PREF = "mail.closeToTray.startInTray";
const WINDOW_TYPE_MAIL_3PANE = "mail:3pane";
const LOG_PREFIX = "MINIMIZETOTRAY-RESTORE:";

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
 * Current tray settings, as last pushed by the WebExtension side via
 * syncTraySettings(). Lives for the lifetime of the add-on process; there's
 * no need to persist it here since the WebExtension's own browser.storage
 * is the source of truth — this is just a cache for the shutdown handler.
 */
let traySettings = { startMinimized: false, enableCloseToTray: false };
let shutdownHandlerRegistered = false;

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

  Services.obs.addObserver(
    {
      observe() {
        const win = Services.wm.getMostRecentWindow(WINDOW_TYPE_MAIL_3PANE);
        if (win) {
          captureMessagePaneState(win);
        }

        if (traySettings.startMinimized && !traySettings.enableCloseToTray) {
          Services.prefs.setBoolPref(CLOSE_TO_TRAY_PREF, true);
        }
      },
    },
    "quit-application-granted"
  );
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
  } catch (ex) {
    console.error(LOG_PREFIX, "Failed to hide window to tray.", ex);
  }
}

/** Windows that already have a "sizemodechange" listener attached. */
const watchedWindows = new WeakSet();

/**
 * Attach a "sizemodechange" listener to `win`, hiding it to the tray
 * whenever it gets minimized. Safe to call more than once per window.
 *
 * @param {Window} win
 */
function watchWindow(win) {
  if (watchedWindows.has(win)) {
    return;
  }
  watchedWindows.add(win);

  win.addEventListener("sizemodechange", () => {
    if (win.windowState === win.STATE_MINIMIZED) {
      console.info(LOG_PREFIX, "Minimize detected, hiding window.");
      hideWindowToTray(win);
    }
  });

  // Capture the pane height whenever the window is about to close — this
  // fires synchronously on the window itself (unlike quit-application-
  // granted, which may arrive after the extension's own context has
  // already started tearing down), and fires whether the window ends up
  // actually closing or being redirected to the tray by native
  // Close to Tray (preventDefault() elsewhere doesn't stop this listener
  // from running).
  win.addEventListener("close", () => {
    captureMessagePaneState(win);
  });
}

/**
 * Start watching every currently open mail:3pane window, and any that open
 * afterwards, for minimize events.
 */
function watchAllWindows() {
  for (const win of Services.wm.getEnumerator(WINDOW_TYPE_MAIL_3PANE)) {
    watchWindow(win);
  }

  Services.obs.addObserver(
    {
      observe(subject) {
        const windowType =
          subject.document?.documentElement?.getAttribute("windowtype");
        if (windowType === WINDOW_TYPE_MAIL_3PANE) {
          subject.addEventListener("load", () => watchWindow(subject), {
            once: true,
          });
        }
      },
    },
    "domwindowopened"
  );

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

  const observer = {
    observe(subject) {
      const windowType =
        subject.document?.documentElement?.getAttribute("windowtype");
      if (windowType === WINDOW_TYPE_MAIL_3PANE) {
        Services.obs.removeObserver(observer, "domwindowopened");
        hideOnStartup(subject);
      }
    },
  };
  Services.obs.addObserver(observer, "domwindowopened");
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
      },
    };
  }
};
