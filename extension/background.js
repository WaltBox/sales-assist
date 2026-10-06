// Clicking the toolbar icon opens the side panel next to Close.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

// Most company websites send X-Frame-Options / CSP frame-ancestors, which stops
// them from loading inside another page. This rule strips those headers only for
// frames loaded outside any browser tab (tabId -1) — i.e. the assistant's own side
// panel — so normal browsing is untouched. It only takes effect on sites the rep
// granted access to via "Enable website view".
const EMBED_RULE_ID = 1;
chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [EMBED_RULE_ID],
  addRules: [{
    id: EMBED_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" },
      ],
    },
    condition: { resourceTypes: ["sub_frame"], tabIds: [chrome.tabs.TAB_ID_NONE] },
  }],
}).catch(console.error);

// The web app (heat map, accounts board) asks for a lead: move the Close tab to it, in whatever window it lives,
// and bring that window forward. The tab in the sender's own window is the last choice, so the board stays put.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== "open-lead" || !/^lead_[A-Za-z0-9]+$/.test(msg.leadId)) return;
  const url = `https://app.close.com/lead/${msg.leadId}/`;
  (async () => {
    const tabs = await chrome.tabs.query({ url: "https://app.close.com/*" });
    const here = sender.tab ? sender.tab.windowId : null;
    const pick = tabs.find((t) => t.windowId !== here && t.active) || tabs.find((t) => t.windowId !== here) || tabs[0];
    if (pick) {
      await chrome.tabs.update(pick.id, { url, active: true });
      await chrome.windows.update(pick.windowId, { focused: true }).catch(() => {});
    } else {
      const win = await chrome.windows.create({ url, focused: true });
      void win;
    }
    reply({ ok: true });
  })().catch((err) => reply({ ok: false, error: String(err) }));
  return true; // async reply
});
