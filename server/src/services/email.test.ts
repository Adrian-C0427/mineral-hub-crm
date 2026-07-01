import { describe, it, expect } from "vitest";
import { personalize, toHtmlBody } from "./email.js";

describe("personalize", () => {
  it("replaces known tokens and escapes HTML", () => {
    const out = personalize("Hi {{buyer}} at {{company}}", { buyer: "A&B <Co>", company: "Acme" });
    expect(out).toBe("Hi A&amp;B &lt;Co&gt; at Acme");
  });
  it("leaves unknown or null tokens intact", () => {
    expect(personalize("{{buyer}} {{missing}}", { buyer: "X", missing: null })).toBe("X {{missing}}");
  });
});

describe("toHtmlBody", () => {
  it("converts newlines to <br> for plain text", () => {
    expect(toHtmlBody("line1\nline2")).toBe("line1<br>line2");
  });
  it("passes through content that already looks like HTML", () => {
    expect(toHtmlBody("<p>hi</p>")).toBe("<p>hi</p>");
  });
});
