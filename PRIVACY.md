# Privacy policy — TradePilot Insight V3
TradePilot Insight is open-source single-owner self-hosted software. It has no developer-operated shared brokerage database or advertising/analytics service.

**Collected in the operator's deployment:** Trading 212 portfolio holdings, aggregate account cash and investment values, optional historical order metadata, local watch-rule thresholds and alert events, owner OAuth client identity and temporary authorization grants. Private API keys/passwords are configured only in the self-hosted server environment.

**Purposes:** account summary, transparent portfolio analytics, read-only historical inspection and optional threshold monitoring. No brokerage execution.

**Recipients:** Trading 212 receives authorized GET requests; an AI host (ChatGPT, Claude, etc.) receives only the selected tool results when the owner invokes the plugin. The host's own retention/privacy policy applies. Do not connect untrusted clients.

**Retention:** OAuth code 5 minutes, refresh grant 14 days or consumed sooner, client metadata 30 minutes, portfolio read cache 30 seconds, monitor events 30 days. Saved rules persist until owner deletes them. Node `.data/` persists until operator deletes it. Hosted service logs depend on the operator's platform settings.

**User controls:** choose sample-only mode, withhold Live broker keys, restrict OAuth origins/scopes, delete watch rules, rotate keys, revoke Trading 212 API access, delete local state and stop deployment.

The repo does not send analytics, keys, conversation history, tracking identifiers or portfolio records to a central service operated by the repository author. No multi-user cloud product is provided.
