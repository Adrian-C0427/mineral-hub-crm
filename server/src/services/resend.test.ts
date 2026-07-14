import { describe, it, expect } from "vitest";
import { formatSender, senderDomain, senderDomainWarning, envResendSender } from "./resend.js";

describe("formatSender", () => {
  it("renders Name <addr> and strips angle brackets from the name", () => {
    expect(formatSender("deals@mail.x.com", "Carsa Minerals")).toBe("Carsa Minerals <deals@mail.x.com>");
    expect(formatSender("deals@mail.x.com", "Bad<script>")).toBe("Badscript <deals@mail.x.com>");
  });
  it("falls back to the bare address without a name", () => {
    expect(formatSender("deals@mail.x.com")).toBe("deals@mail.x.com");
    expect(formatSender("deals@mail.x.com", "  ")).toBe("deals@mail.x.com");
  });
});

describe("senderDomain", () => {
  it("extracts the domain, lowercased", () => {
    expect(senderDomain("Deals@Mail.X.com")).toBe("mail.x.com");
  });
  it("rejects addresses without a domain", () => {
    expect(senderDomain("not-an-email")).toBeNull();
    expect(senderDomain("@x.com")).toBeNull();
  });
});

describe("senderDomainWarning", () => {
  const domains = [
    { name: "mail.x.com", status: "verified" },
    { name: "pending.x.com", status: "pending" },
  ];
  it("passes a sender on a verified domain", () => {
    expect(senderDomainWarning("deals@mail.x.com", domains)).toBeNull();
    expect(senderDomainWarning("deals@MAIL.X.COM", domains)).toBeNull(); // case-insensitive
  });
  it("warns when the domain is registered but unverified", () => {
    expect(senderDomainWarning("a@pending.x.com", domains)).toContain('"pending"');
  });
  it("warns when the domain is not on the account at all", () => {
    expect(senderDomainWarning("a@elsewhere.com", domains)).toContain("not registered");
  });
  it("warns on an invalid sender address", () => {
    expect(senderDomainWarning("nope", domains)).toContain("not a valid sender");
  });
});

describe("envResendSender", () => {
  it("is null unless both RESEND_API_KEY and RESEND_FROM are set", () => {
    // Test env doesn't set them, so the fallback must be inert.
    expect(envResendSender()).toBeNull();
  });
});
