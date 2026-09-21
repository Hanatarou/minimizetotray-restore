/**
 * Options page logic for MinimizeToTray Restore.
 * Loads and persists the tray preferences via storage.local, and pushes
 * them to the Experiment API so the native mail.closeToTray prefs stay
 * in sync immediately (not just at next startup).
 */

/**
 * Manifest.json fields get __MSG_key__ substituted automatically, but plain
 * HTML content does not — replace any __MSG_key__ placeholder found in text
 * nodes (and the document title) with the matching localized string.
 */
function localizePage() {
  document.title = document.title.replace(
    /__MSG_(\w+)__/g,
    (_, key) => browser.i18n.getMessage(key)
  );

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue.includes("__MSG_")) {
      node.nodeValue = node.nodeValue.replace(
        /__MSG_(\w+)__/g,
        (_, key) => browser.i18n.getMessage(key)
      );
    }
  }
}

localizePage();

const DEFAULTS = {
  startMinimized: false,
  enableCloseToTray: false,
  showTooltip: true,
};

const startMinimizedCheckbox = document.getElementById("startMinimized");
const enableCloseToTrayCheckbox = document.getElementById("enableCloseToTray");
const showTooltipCheckbox = document.getElementById("showTooltip");

const settings = await browser.storage.local.get(DEFAULTS);
startMinimizedCheckbox.checked = settings.startMinimized;
enableCloseToTrayCheckbox.checked = settings.enableCloseToTray;
showTooltipCheckbox.checked = settings.showTooltip;

async function pushSettings() {
  const current = await browser.storage.local.get(DEFAULTS);
  await browser.MinimizeToTray.syncTraySettings(
    current.startMinimized,
    current.enableCloseToTray
  );
}

startMinimizedCheckbox.addEventListener("change", async () => {
  await browser.storage.local.set({
    startMinimized: startMinimizedCheckbox.checked,
  });
  await pushSettings();
});

enableCloseToTrayCheckbox.addEventListener("change", async () => {
  await browser.storage.local.set({
    enableCloseToTray: enableCloseToTrayCheckbox.checked,
  });
  await pushSettings();
});

showTooltipCheckbox.addEventListener("change", async () => {
  await browser.storage.local.set({
    showTooltip: showTooltipCheckbox.checked,
  });
  // Take effect right away instead of waiting for the next folder change.
  await browser.runtime.sendMessage({ type: "showTooltipChanged" });
});
