// Runs on the assistant's web app (the heat map, the accounts board). When the page asks for a lead to open, the
// extension steers the Close tab in whichever window it's in (Walt 10/6: "I have multiple windows open; when
// clicked, the Close window needs to follow"). A web page can't reach other windows; the extension can.
window.addEventListener("westgate:open-lead", (e) => {
  const leadId = e.detail && e.detail.leadId;
  if (!leadId) return;
  chrome.runtime.sendMessage({ type: "open-lead", leadId }, (r) => {
    window.dispatchEvent(new CustomEvent("westgate:open-lead-ack", { detail: { leadId, ok: !chrome.runtime.lastError && r && r.ok } }));
  });
});
