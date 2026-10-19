import { COMPANY_DOMAIN } from "./auth.js";
import type { CloseMe } from "./close.js";

/**
 * Every email goes out from the rep's own Westgate address (Walt 10/19): the Close email account connected to their
 * own @westgatesupply.com address. No other account is ever used, not a teammate's, not a personal Gmail. A rep
 * with no such account connected in Close can't send until they connect it.
 */
export class SendingError extends Error {
  status = 409;
}

export type SendingAccount = { sender: string; emailAccountId: string; email: string };

export function sendingAccount(me: Pick<CloseMe, "email" | "email_accounts">, repEmail: string, repName: string): SendingAccount | null {
  const want = repEmail.trim().toLowerCase();
  if (!want.endsWith(`@${COMPANY_DOMAIN}`)) return null;
  const a = (me.email_accounts ?? []).find((x) => x.email.trim().toLowerCase() === want && x.send_status !== "error");
  if (!a) return null;
  const from = (a.sender?.email || a.email).trim().toLowerCase();
  if (from !== want) return null; // a "send as" set to some other address doesn't count
  return { sender: `"${(a.sender?.name || repName).replaceAll('"', "")}" <${a.email}>`, emailAccountId: a.id, email: a.email };
}

export const noAccountMessage = (repEmail: string) =>
  `Nothing was sent: your ${repEmail.endsWith(`@${COMPANY_DOMAIN}`) ? repEmail : `@${COMPANY_DOMAIN}`} email isn't connected in Close. Connect it in Close (Settings, Connected Accounts), then try again.`;

/**
 * The one place emails are made: every email this rep creates carries their own account, whatever the caller
 * passed, and none is made without one.
 */
export function guardSending<C extends { createDraftEmail: (leadId: string, e: never) => unknown }>(close: C, account: SendingAccount | null, repEmail: string): C {
  return new Proxy(close, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "createDraftEmail") return typeof v === "function" ? v.bind(target) : v;
      return (leadId: string, e: Record<string, unknown>) => {
        if (!account) return Promise.reject(new SendingError(noAccountMessage(repEmail)));
        return (v as (l: string, e: unknown) => unknown).call(target, leadId, { ...e, sender: account.sender, emailAccountId: account.emailAccountId });
      };
    },
  });
}
