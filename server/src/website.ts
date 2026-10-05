import dns from "node:dns/promises";
import net from "node:net";

// Reads the prospect's homepage as plain text for the Lead Brief. The URL comes
// from Close data, so guard against pointing the server at internal hosts.

const MAX_CHARS = 5000;
const BUDGET_MS = 4000; // a slow or dead site must not hold up the brief
const cache = new Map<string, { at: number; text: string | null }>();
const TTL_MS = 24 * 3600 * 1000;

function isPrivate(ip: string): boolean {
  if (net.isIPv6(ip)) return ip === "::1" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith("::ffff:") && isPrivate(ip.slice(7));
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export async function fetchSiteText(rawUrl: string | null | undefined): Promise<string | null> {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }
  const hit = cache.get(url.href);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;

  let text: string | null = null;
  try {
    // Follow redirects by hand so every hop gets the same public-address check.
    let target = url;
    const signal = AbortSignal.timeout(BUDGET_MS);
    for (let hop = 0; hop < 4; hop++) {
      if (!["http:", "https:"].includes(target.protocol)) break;
      const addrs = await dns.lookup(target.hostname, { all: true });
      if (addrs.length === 0 || addrs.some((a) => isPrivate(a.address))) break;
      const res = await fetch(target, {
        redirect: "manual",
        signal,
        headers: { "user-agent": "Mozilla/5.0 (compatible; WestgateSalesAssistant/1.0)", accept: "text/html" },
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        target = new URL(location, target);
        continue;
      }
      if (res.ok && (res.headers.get("content-type") ?? "").includes("html")) {
        text = htmlToText(await res.text()).slice(0, MAX_CHARS);
      }
      break;
    }
  } catch {
    text = null; // unreachable sites are a heads-up, not an error
  }
  cache.set(url.href, { at: Date.now(), text });
  return text;
}

// ---------- email addresses on their site (Walt 9/29, DMG Contractors: no email in Close, two on the site) ----------

const emailCache = new Map<string, { at: number; emails: string[] }>();

/** One page's raw HTML, with the same public-address guard and redirect handling as the homepage read. */
async function fetchHtml(start: URL, signal: AbortSignal): Promise<string | null> {
  let target = start;
  for (let hop = 0; hop < 4; hop++) {
    if (!["http:", "https:"].includes(target.protocol)) return null;
    const addrs = await dns.lookup(target.hostname, { all: true });
    if (addrs.length === 0 || addrs.some((a) => isPrivate(a.address))) return null;
    const res = await fetch(target, { redirect: "manual", signal, headers: { "user-agent": "Mozilla/5.0 (compatible; WestgateSalesAssistant/1.0)", accept: "text/html" } });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) { target = new URL(location, target); continue; }
    return res.ok && (res.headers.get("content-type") ?? "").includes("html") ? await res.text() : null;
  }
  return null;
}

/** Addresses on their homepage and contact page, their own domain first. Never throws; [] when the site won't load. */
export async function siteEmails(rawUrl: string | null | undefined): Promise<string[]> {
  if (!rawUrl) return [];
  let url: URL;
  try { url = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`); } catch { return []; }
  const hit = emailCache.get(url.origin);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.emails;
  const signal = AbortSignal.timeout(BUDGET_MS);
  const pages = await Promise.all(["/", "/contact", "/contact-us"].map((p) => fetchHtml(new URL(p, url.origin), signal).catch(() => null)));
  const found = new Map<string, string>();
  for (const html of pages) {
    for (const m of (html ?? "").matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      const e = m[0].replace(/^mailto:/i, "");
      if (/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(e) || /sentry|wixpress|example|mysite|yoursite|domain\.com|email\.com|yourname|name@/i.test(e)) continue;
      if (!found.has(e.toLowerCase())) found.set(e.toLowerCase(), e.toLowerCase());
    }
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const emails = [...found.values()].sort((a, b) => Number(b.endsWith(`@${host}`)) - Number(a.endsWith(`@${host}`))).slice(0, 5);
  emailCache.set(url.origin, { at: Date.now(), emails });
  return emails;
}
