export type OAuthPageLocale = "en" | "zh-CN";

export interface OAuthPageCopy {
  connectTitle: string;
  description: string;
  unnamedClient: string;
  permissionsTitle: string;
  scopes: Record<string, string>;
  unknownHost: string;
  /** Checkbox for trade:write; left unticked for unknown hosts, so a read-only grant is the default there. */
  allowWrite: string;
  fieldLabel: string;
  submitLabel: string;
  securityNote: string;
  deniedTitle: string;
  invalidCredential: string;
  tooManyTitle: string;
  tryLater: string;
}

const COPY: Record<OAuthPageLocale, OAuthPageCopy> = {
  en: {
    connectTitle: "Connect TradePilot 212",
    description: "{client} wants to connect to your TradePilot. After you sign in, you go back to {host}.",
    unnamedClient: "An app",
    permissionsTitle: "It will be able to",
    scopes: {
      "trade:read": "Read your Trading 212 portfolio, orders and history",
      "trade:write": "Prepare orders and pie changes; each one still needs your confirmation",
      offline_access: "Stay connected without asking for this password again",
    },
    unknownHost: "{host} is not ChatGPT or Claude. Only continue if you added this connection yourself.",
    allowWrite: "Also allow it to prepare orders and pie changes (each one still needs your confirmation). Leave unticked for read-only access.",
    fieldLabel: "Connection password",
    submitLabel: "Authorize & connect",
    securityNote: "OAuth + PKCE · No trade is performed on this page",
    deniedTitle: "Authorization denied",
    invalidCredential: "The password is incorrect. Go back and try again.",
    tooManyTitle: "Too many attempts",
    tryLater: "Please try again later.",
  },
  "zh-CN": {
    connectTitle: "连接 TradePilot 212",
    description: "{client} 请求连接你的 TradePilot。登录后会返回 {host}。",
    unnamedClient: "一个应用",
    permissionsTitle: "它将可以",
    scopes: {
      "trade:read": "读取你的 Trading 212 持仓、订单和历史",
      "trade:write": "准备订单和 Pie 修改，每一笔仍需你确认",
      offline_access: "保持连接，不再重复输入这个密码",
    },
    unknownHost: "{host} 不是 ChatGPT 或 Claude。只有在你自己添加了这个连接时才继续。",
    allowWrite: "同时允许它准备订单和 Pie 修改（每一笔仍需你确认）。不勾选则只能读取。",
    fieldLabel: "连接密码",
    submitLabel: "授权并连接",
    securityNote: "OAuth + PKCE · 此页面不会执行任何交易",
    deniedTitle: "授权失败",
    invalidCredential: "密码不正确，请返回重试。",
    tooManyTitle: "尝试次数过多",
    tryLater: "请稍后再试。",
  },
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function resolveOAuthLocale(value?: string | null): OAuthPageLocale {
  return /(^|[,\s])zh(?:-|_|,|$)/i.test(value ?? "") ? "zh-CN" : "en";
}

export function oauthPageCopy(locale: OAuthPageLocale): OAuthPageCopy {
  return COPY[locale] ?? COPY.en;
}

const CSS = `
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#f5f5f4;color:#171717}
.authShell{min-height:100vh;display:grid;place-items:center;padding:28px}
.authCard{width:min(440px,100%);padding:28px;border:1px solid #dededb;border-radius:22px;background:#fff;box-shadow:0 22px 65px rgba(0,0,0,.08)}
.brand{display:flex;align-items:center;gap:11px;margin-bottom:30px}.mark{width:42px;height:42px;display:grid;place-items:center;border-radius:13px;background:#191a1c;color:#fff;font-size:13px;font-weight:800}
.brand span,.brand strong{display:block}.brand span{color:#797979;font-size:10px;text-transform:uppercase;letter-spacing:.07em}.brand strong{margin-top:2px;font-size:15px}
.language{display:flex;justify-content:flex-end;gap:6px;margin:-54px 0 32px}.language a{padding:5px 7px;border-radius:8px;color:#777;text-decoration:none;font-size:10px;font-weight:700}.language a.active{background:#f1f1ef;color:#171717}
h1{margin:0 0 9px;font-size:27px;line-height:1.1;letter-spacing:-.045em}p{margin:0;color:#666;font-size:13px;line-height:1.55}
.field{display:grid;gap:7px;margin-top:24px}.field span{color:#777;font-size:10px;font-weight:650}
input{width:100%;height:46px;padding:0 13px;border:1px solid #d7d7d4;border-radius:12px;background:#fff;color:#171717;font:inherit;font-size:14px;outline:none}input:focus{border-color:#777;box-shadow:0 0 0 3px rgba(0,0,0,.05)}
button{width:100%;height:46px;margin-top:11px;border:0;border-radius:12px;background:#191a1c;color:#fff;font:inherit;font-size:13px;font-weight:750;cursor:pointer}
.permissions{margin:18px 0 0;padding:12px 14px;border:1px solid #e6e6e3;border-radius:12px;background:#fafaf9}.permissions strong{display:block;margin-bottom:6px;font-size:11px;color:#555}.permissions ul{margin:0;padding-left:18px;color:#444;font-size:12px;line-height:1.6}
.allow{display:flex;gap:10px;align-items:flex-start;margin-top:14px;color:#444;font-size:12px;line-height:1.5;cursor:pointer}.allow input{flex:none;width:20px;height:20px;margin:0;padding:0;accent-color:#191a1c}
.warning{margin-top:14px;padding:10px 12px;border-radius:10px;background:#fff4e0;color:#7a4e05;font-size:12px;line-height:1.5}
.security{display:flex;align-items:center;gap:7px;margin-top:16px;color:#888;font-size:10px}.security:before{content:"";width:7px;height:7px;border-radius:50%;background:#28a36a;box-shadow:0 0 0 3px rgba(40,163,106,.1)}
@media(max-width:520px){body{background:#fff}.authShell{display:block;padding:24px 18px}.authCard{width:100%;padding:20px 0;border:0;box-shadow:none}.language{margin-top:-50px}}
@media(prefers-color-scheme:dark){body{background:#111;color:#f5f5f5}.authCard{background:#181818;border-color:#303030}.brand span,p,.field span,.security{color:#aaa}.language a{color:#aaa}.language a.active{background:#292929;color:#fff}input{background:#151515;border-color:#353535;color:#fff}button{background:#f2f2f2;color:#111}.permissions{background:#1f1f1f;border-color:#303030}.permissions strong,.permissions ul,.allow{color:#ccc}.allow input{accent-color:#f2f2f2}.warning{background:#3b2c0e;color:#f2c66b}}
`;

export function renderOAuthPage(input: {
  locale: OAuthPageLocale;
  /** Chosen by whoever registered the client, so it is shown as a claim next to the real redirect host. */
  clientName: string;
  redirectHost: string;
  knownClient: boolean;
  scopes: string[];
  hiddenHtml: string;
  zhUrl: string;
  enUrl: string;
}): string {
  const copy = oauthPageCopy(input.locale);
  const description = copy.description.replace("{client}", input.clientName || copy.unnamedClient).replace("{host}", input.redirectHost);
  const permissions = input.scopes.filter((scope) => scope !== "trade:write").map((scope) => copy.scopes[scope]).filter(Boolean).map((text) => `<li>${escapeHtml(text!)}</li>`).join("");
  const warning = input.knownClient ? "" : `<div class="warning" role="alert">${escapeHtml(copy.unknownHost.replace("{host}", input.redirectHost))}</div>`;
  const allowWrite = input.scopes.includes("trade:write")
    ? `<label class="allow"><input type="checkbox" name="allow_write" value="on"${input.knownClient ? " checked" : ""}><span>${escapeHtml(copy.allowWrite)}</span></label>`
    : "";
  return `<!doctype html><html lang="${input.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>TradePilot 212</title><style>${CSS}</style></head><body><main class="authShell"><section class="authCard"><div class="brand"><div class="mark">TP</div><div><span>Trading 212 Invest</span><strong>TradePilot 212</strong></div></div><nav class="language"><a class="${input.locale === "zh-CN" ? "active" : ""}" href="${escapeHtml(input.zhUrl)}">中文</a><a class="${input.locale === "en" ? "active" : ""}" href="${escapeHtml(input.enUrl)}">EN</a></nav><h1>${escapeHtml(copy.connectTitle)}</h1><p>${escapeHtml(description)}</p>${permissions ? `<div class="permissions"><strong>${escapeHtml(copy.permissionsTitle)}</strong><ul>${permissions}</ul></div>` : ""}${warning}<form method="post">${input.hiddenHtml}${allowWrite}<label class="field"><span>${escapeHtml(copy.fieldLabel)}</span><input name="password" type="password" autocomplete="current-password" autofocus required></label><button type="submit">${escapeHtml(copy.submitLabel)}</button></form><div class="security">${escapeHtml(copy.securityNote)}</div></section></main></body></html>`;
}

export function renderOAuthMessagePage(locale: OAuthPageLocale, title: string, message: string): string {
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · TradePilot 212</title><style>${CSS}</style></head><body><main class="authShell"><section class="authCard"><div class="brand"><div class="mark">TP</div><div><span>Trading 212 Invest</span><strong>TradePilot 212</strong></div></div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></section></main></body></html>`;
}
