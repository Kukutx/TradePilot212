export const APP_META = {
  name: "TradePilot 212",
  brokerName: "Trading 212 Invest",
  version: "2.99.0",
  websiteUrl: "https://github.com/Kukutx/TradePilot212",
} as const;

/** The app's mark, as the widget's header draws it: a rising line on the brand gradient. */
export const APP_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0e9f6e"/><stop offset=".62" stop-color="#1d6fd8"/><stop offset="1" stop-color="#4f46e5"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><path d="M14 44l11-12 8 7 17-18" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="50" cy="21" r="4" fill="#fff"/></svg>';

export const APP_ICON_DATA_URI = `data:image/svg+xml;base64,${btoa(APP_ICON_SVG)}`;
