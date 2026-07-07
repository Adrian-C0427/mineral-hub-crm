import { describe, it, expect } from "vitest";
import { personalize, renderEmailBody } from "./email.js";

describe("personalize", () => {
  it("replaces known tokens with plain values (no escaping — subjects are plain text)", () => {
    const out = personalize("Hi {{buyer}} at {{company}}", { buyer: "A&B <Co>", company: "Acme" });
    expect(out).toBe("Hi A&B <Co> at Acme");
  });
  it("leaves unknown or null tokens intact", () => {
    expect(personalize("{{buyer}} {{missing}}", { buyer: "X", missing: null })).toBe("X {{missing}}");
  });
});

describe("renderEmailBody", () => {
  it("escapes a plain-text body exactly once and converts newlines", () => {
    expect(renderEmailBody("Hi {{buyer}}\nBest", { buyer: "A&B <Co>" }))
      .toBe("Hi A&amp;B &lt;Co&gt;<br>Best");
  });
  it("does not double-escape ampersands in values", () => {
    expect(renderEmailBody("{{company}}", { company: "Smith & Sons" })).toBe("Smith &amp; Sons");
  });
  it("passes HTML templates through but escapes substituted values", () => {
    expect(renderEmailBody("<p>Hi {{buyer}}</p>", { buyer: "A<script>" }))
      .toBe("<p>Hi A&lt;script&gt;</p>");
  });
  it("decides HTML-vs-plain on the template, not the values", () => {
    // A "<" inside a value must not switch a plain-text email to raw HTML.
    expect(renderEmailBody("Hi {{buyer}}", { buyer: "<b>X</b>" })).toBe("Hi &lt;b&gt;X&lt;/b&gt;");
  });
});
