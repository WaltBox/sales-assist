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
