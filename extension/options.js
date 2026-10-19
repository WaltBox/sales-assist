const $ = (id) => document.getElementById(id);
// The hosted app (10/19): new installs use it, so nobody needs a server on their own computer.
const HOSTED = "https://sales-assist-fawn.vercel.app";
let current = { server: "", token: "" };

function serverUrl() {
  try { return new URL($("server").value.trim()).origin; } catch { return null; }
}

async function whoAmI(server, token) {
  if (!server || !token) return null;
  try {
    const res = await fetch(`${server}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    return res.ok ? (await res.json()).rep : null;
  } catch {
    return null;
  }
}

async function show() {
  const rep = await whoAmI(current.server, current.token);
  $("signed-in").hidden = !rep;
  $("signin").hidden = !!rep;
  $("save").textContent = rep ? "Save" : "Sign in";
  if (rep) $("who").textContent = `${rep.name} (${rep.email})`;
  $("webapp").href = current.server || serverUrl() || HOSTED;
}

chrome.storage.local.get(["server", "token", "theme"]).then(({ server, token, theme }) => {
  current = { server: server || HOSTED, token: token || "" };
  $("server").value = current.server;
  $("theme-select").value = theme || "light";
  document.documentElement.dataset.theme = theme || "light";
  show();
});

// Theme applies right away (the open side panel follows along).
$("theme-select").addEventListener("change", async () => {
  const theme = $("theme-select").value;
  document.documentElement.dataset.theme = theme;
  await chrome.storage.local.set({ theme });
});

$("signout").addEventListener("click", async () => {
  current.token = "";
  await chrome.storage.local.set({ token: "" });
  $("status").textContent = "Signed out.";
  show();
});

async function save() {
  const status = $("status");
  const server = serverUrl();
  if (!server) { status.textContent = "That server address isn't a valid URL."; return; }
  // Production servers are https:// and need a one-time permission grant.
  if (!server.startsWith("http://localhost") && server !== HOSTED) {
    const granted = await chrome.permissions.request({ origins: [`${server}/*`] });
    if (!granted) { status.textContent = "Chrome permission is needed to reach the server."; return; }
  }
  if (!$("signin").hidden) {
    status.textContent = "Signing in…";
    try {
      const res = await fetch(`${server}/api/auth/login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: $("email").value, password: $("password").value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { status.textContent = body.error || "Couldn't sign in."; return; }
      current = { server, token: body.token };
      $("password").value = "";
    } catch {
      status.textContent = "The server didn't answer. Check the address.";
      return;
    }
  } else {
    current.server = server;
  }
  await chrome.storage.local.set(current);
  status.textContent = "Done. Open a lead in Close and click the toolbar icon.";
  show();
}
$("save").addEventListener("click", save);
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
