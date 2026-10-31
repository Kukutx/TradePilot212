// A host that shows no widget (a terminal such as Claude Code) runs the order flow as two tool calls the model makes:
// app_prepare_* and app_execute_*, with the model's word that the user said yes in between. When that host can show
// its own form (MCP elicitation), the execute call first asks the user there, so the send waits on the user's own
// answer and not on the model's. A host that renders the widget is never asked: the user confirms in the widget.

import { getUiCapability } from "@modelcontextprotocol/ext-apps/server";
import { inputRequired, inputResponse, type McpServer } from "@modelcontextprotocol/server";
import type { OrderDraft } from "../shared/contracts.js";
import { fail } from "./errors.js";
import type { NotifyLocale } from "./notify.js";
import type { PendingDescription } from "./trading-service.js";

/** The key of the one question in the form, as it comes back on the retried call. */
const CONFIRM_KEY = "confirm";
/** At most this many legs of a basket are listed in the form; the rest are counted. */
const LISTED_LEGS = 10;

const WORDS = {
  en: {
    side: { buy: "Buy", sell: "Sell" },
    order: (environment: string) => `Send this order to your Trading 212 ${environment} account?`,
    basket: (environment: string, title: string, count: number) => `Send the basket "${title}", ${count} order${count === 1 ? "" : "s"}, to your Trading 212 ${environment} account?`,
    cancel: (environment: string, orderId: string) => `Cancel order ${orderId} in your Trading 212 ${environment} account? A cancelled stop-loss no longer protects the position.`,
    pie: (environment: string, action: string, pie: string) => `${{ create: "Create", update: "Change", duplicate: "Duplicate", delete: "Delete" }[action] ?? action} ${pie} in your Trading 212 ${environment} account?`,
    pieName: (name: string | undefined, id: number | undefined) => name ? `the pie "${name}"` : id === undefined ? "a pie" : `pie ${id}`,
    more: (count: number) => `and ${count} more`,
    at: { limit: "limit", stop: "stop" },
    market: "at market",
    join: ", ",
    leg: (side: string, quantity: number, ticker: string, terms: string, gtc: boolean) => `${side} ${quantity} ${ticker}, ${terms}${gtc ? ", good till cancelled" : ""}`,
    send: "Send it",
    realMoney: "I understand this uses real money",
    live: "LIVE",
    demo: "DEMO",
    declined: "Not sent: the confirmation was declined. The token stays valid until it expires.",
    unticked: "Not sent: a Live write needs the real-money box ticked in the confirmation.",
  },
  "zh-CN": {
    side: { buy: "买入", sell: "卖出" },
    order: (environment: string) => `把这笔订单发送到你的 Trading 212 ${environment}账户？`,
    basket: (environment: string, title: string, count: number) => `把篮子「${title}」的 ${count} 笔订单发送到你的 Trading 212 ${environment}账户？`,
    cancel: (environment: string, orderId: string) => `撤销你 Trading 212 ${environment}账户里的订单 ${orderId}？止损单撤销后，这笔持仓就不再受保护。`,
    pie: (environment: string, action: string, pie: string) => `在你的 Trading 212 ${environment}账户里${{ create: "新建", update: "修改", duplicate: "复制", delete: "删除" }[action] ?? action}${pie}？`,
    pieName: (name: string | undefined, id: number | undefined) => name ? `组合「${name}」` : id === undefined ? "一个组合" : `组合 ${id}`,
    more: (count: number) => `另有 ${count} 笔`,
    at: { limit: "限价", stop: "止损价" },
    market: "市价",
    join: "，",
    leg: (side: string, quantity: number, ticker: string, terms: string, gtc: boolean) => `${side} ${quantity} 股 ${ticker}，${terms}${gtc ? "，撤销前有效" : ""}`,
    send: "确认发送",
    realMoney: "我明白这会使用真实资金",
    live: "实盘",
    demo: "模拟",
    declined: "未发送：确认被拒绝。令牌在过期前仍然有效。",
    unticked: "未发送：实盘操作需要在确认框里勾选“使用真实资金”。",
  },
} as const;

type Words = (typeof WORDS)[NotifyLocale];

function legText(draft: OrderDraft, words: Words): string {
  const prices = [
    draft.stopPrice === undefined ? "" : `${words.at.stop} ${draft.stopPrice}`,
    draft.limitPrice === undefined ? "" : `${words.at.limit} ${draft.limitPrice}`,
  ].filter(Boolean).join(words.join);
  return words.leg(words.side[draft.side], draft.quantity, draft.ticker, prices || words.market, draft.timeValidity === "GOOD_TILL_CANCEL");
}

/** The form's message: what will be sent, one order per line. */
export function confirmationMessage(pending: PendingDescription, locale: NotifyLocale = "en"): string {
  const words = WORDS[locale];
  const environment = pending.environment === "live" ? words.live : words.demo;
  if (pending.kind === "cancel") return words.cancel(environment, pending.orderId);
  if (pending.kind === "pie") return words.pie(environment, pending.action, words.pieName(pending.name, pending.pieId));
  const head = pending.kind === "order" ? words.order(environment) : words.basket(environment, pending.title ?? "", pending.drafts.length);
  const legs = pending.drafts.slice(0, LISTED_LEGS).map((draft) => `- ${legText(draft, words)}`);
  if (pending.drafts.length > LISTED_LEGS) legs.push(`- ${words.more(pending.drafts.length - LISTED_LEGS)}`);
  return [head, ...legs].join("\n");
}

/** Whether this host can show a form and does not render the widget. */
function asksInHost(server: McpServer): boolean {
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities || getUiCapability(capabilities)) return false;
  const elicitation = capabilities.elicitation as { form?: unknown; url?: unknown } | undefined;
  // An empty elicitation capability means the form mode, as the specification had it before URLs.
  return !!elicitation && (elicitation.form !== undefined || elicitation.url === undefined);
}

export type HostConfirmation =
  /** Go on and send. `liveAcknowledged` is true when the user ticked the real-money box in the form. */
  | { send: true; liveAcknowledged: boolean }
  /** Return this to the host: the form to show, after which the host calls the tool again with the answer. */
  | { send: false; ask: ReturnType<typeof inputRequired> };

/**
 * Ask the user in the host before an app_execute_* call sends anything, when the host can ask and shows no widget.
 * A host that cannot ask goes on as before, on the model's word and the host's own permission prompt. A declined
 * form, or a Live one without the real-money box ticked, throws CONFIRMATION_DECLINED and leaves the token unused.
 */
export async function confirmInHost(server: McpServer, ctx: unknown, describe: () => Promise<PendingDescription>, locale: NotifyLocale = "en"): Promise<HostConfirmation> {
  if (!asksInHost(server)) return { send: true, liveAcknowledged: false };
  // The token is read first, so an expired one says so rather than asking about nothing.
  const pending = await describe();
  const live = pending.environment === "live";
  const words = WORDS[locale];
  const responses = (ctx as { mcpReq?: { inputResponses?: Record<string, unknown> } } | undefined)?.mcpReq?.inputResponses;
  const answer = inputResponse(responses, CONFIRM_KEY);
  if (answer.kind === "elicit") {
    if (answer.action !== "accept" || answer.content?.send !== true) fail("CONFIRMATION_DECLINED", words.declined);
    if (live && answer.content?.realMoney !== true) fail("CONFIRMATION_DECLINED", words.unticked);
    return { send: true, liveAcknowledged: live };
  }
  return {
    send: false,
    ask: inputRequired({
      inputRequests: {
        [CONFIRM_KEY]: inputRequired.elicit({
          message: confirmationMessage(pending, locale),
          requestedSchema: {
            type: "object",
            properties: {
              send: { type: "boolean", title: words.send, default: false },
              ...(live ? { realMoney: { type: "boolean", title: words.realMoney, default: false } } : {}),
            },
            required: live ? ["send", "realMoney"] : ["send"],
          },
        }),
      },
    }),
  };
}
