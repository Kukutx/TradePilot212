import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState, SearchField } from "./common";

const noop = () => {};

describe("an empty panel", () => {
  it("keeps the panel's title and offers the next step as a button", () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { title: "Income by month", text: "No dividends.", action: { label: "Show all time", onClick: noop } }));
    expect(html).toBe('<h2 class="panelTitle">Income by month</h2><div class="emptyState compact withAction"><span>No dividends.</span><button type="button" class="linkButton">Show all time</button></div>');
  });

  it("is a sentence alone when there is no next step", () => {
    expect(renderToStaticMarkup(createElement(EmptyState, { text: "No pies." }))).toBe('<div class="emptyState compact"><span>No pies.</span></div>');
  });
});

describe("a search box", () => {
  const render = (value: string) => renderToStaticMarkup(createElement(SearchField, { value, onValue: noop, clearLabel: "Clear the search", "aria-label": "Filter" }));

  it("draws its own clear button only once something is typed", () => {
    expect(render("")).not.toContain("searchClear");
    const html = render("app");
    expect(html).toContain('class="searchField filled"');
    expect(html).toContain('<button type="button" class="searchClear" aria-label="Clear the search" title="Clear the search">');
    expect(html).toContain('type="search"');
  });
});
