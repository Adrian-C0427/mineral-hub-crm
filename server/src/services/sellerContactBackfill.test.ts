import { describe, it, expect } from "vitest";
import { matchSellerToContact } from "./sellerContactBackfill.js";
import { dealStatus } from "../domain/stages.js";

const contacts = [
  { id: "c_mary", firstName: "Mary", lastName: "Hernandez", entityName: null, email: "mary@example.com", phone: "9035551234" },
  { id: "c_trust", firstName: "Lone Star Family Trust", lastName: "", entityName: "Lone Star Family Trust", email: null, phone: "(214) 555-0101" },
  { id: "c_john", firstName: "John", lastName: "Smith", entityName: null, email: null, phone: "9035551234" },
];
const seller = (over: Partial<Parameters<typeof matchSellerToContact>[0]>) => ({
  id: "s1", dealId: "d1", isPrimary: true, contactId: null, firstName: null, lastName: null, companyName: null, email: null, primaryPhone: null, ...over,
});

describe("matchSellerToContact — only reliable identifiers link an old seller to a contact", () => {
  it("a converted opportunity's contact is the deal's primary seller", () => {
    expect(matchSellerToContact(seller({ firstName: "Anyone" }), contacts, "c_opp")).toBe("c_opp");
    expect(matchSellerToContact(seller({ firstName: "Anyone", isPrimary: false }), contacts, "c_opp")).toBeNull();
  });
  it("matches on email regardless of case", () => {
    expect(matchSellerToContact(seller({ email: "MARY@example.com", firstName: "M" }), contacts, null)).toBe("c_mary");
  });
  it("matches on phone + exact person name or entity name, never phone alone", () => {
    expect(matchSellerToContact(seller({ primaryPhone: "903-555-1234", firstName: "john", lastName: "SMITH" }), contacts, null)).toBe("c_john");
    expect(matchSellerToContact(seller({ primaryPhone: "903-555-1234", firstName: "Jose", lastName: "Smith" }), contacts, null)).toBeNull();
    expect(matchSellerToContact(seller({ primaryPhone: "2145550101", companyName: "lone star family trust" }), contacts, null)).toBe("c_trust");
  });
  it("never links on a name alone", () => {
    expect(matchSellerToContact(seller({ firstName: "Mary", lastName: "Hernandez" }), contacts, null)).toBeNull();
  });
});

describe("dealStatus — the system status behind a contact's mineral interest", () => {
  it("comes from the stage KEY: the two terminal keys, else under contract", () => {
    expect(dealStatus("CLOSED")).toBe("CLOSED");
    expect(dealStatus("DEAD")).toBe("DEAD");
    for (const k of ["UNDER_CONTRACT", "NEGOTIATING", "CLOSING", "MY_CUSTOM_STAGE"]) expect(dealStatus(k)).toBe("UNDER_CONTRACT");
  });
});

import { ambiguityOf, sellerInfoFromLegacyName, sellerInfoFromStored } from "./sellerContactBackfill.js";

describe("create pass — building seller blocks from stored records, and refusing ambiguous ones", () => {
  it("reads a legacy seller name as a person or an entity", () => {
    expect(sellerInfoFromLegacyName("Mary Hernandez")).toMatchObject({ firstName: "Mary", lastName: "Hernandez", companyName: null });
    expect(sellerInfoFromLegacyName("Smith, Robert")).toMatchObject({ firstName: "Robert", lastName: "Smith" });
    expect(sellerInfoFromLegacyName("Lone Star Family Trust")).toMatchObject({ companyName: "Lone Star Family Trust", sellerType: "OTHER" });
    expect(sellerInfoFromLegacyName("  ")).toBeNull();
  });
  it("reads an opportunity's plain fields; an unusable email is dropped, not fatal", () => {
    expect(sellerInfoFromStored({ sellerName: "Ann Lee", phone: "(903) 555-0000", email: "not-an-email" })).toMatchObject({ firstName: "Ann", lastName: "Lee", phone: "9035550000", email: null });
    expect(sellerInfoFromStored({ trustName: "Pecan Estate" })).toMatchObject({ companyName: "Pecan Estate" });
    expect(sellerInfoFromStored({ phone: "9035550000" })).toBeNull(); // no name at all
  });
  it("flags two contacts answering the same reliable key instead of picking one", () => {
    const two = [
      { id: "a", firstName: "Mary", lastName: "Hernandez", entityName: null, email: "m@x.com", phone: null },
      { id: "b", firstName: "Mary", lastName: "Hernandez", entityName: null, email: "m@x.com", phone: null },
    ];
    expect(ambiguityOf(sellerInfoFromStored({ firstName: "Mary", lastName: "Hernandez", email: "m@x.com" })!, two)).toMatch(/share the email/);
    expect(ambiguityOf(sellerInfoFromStored({ firstName: "Mary", lastName: "Hernandez" })!, two)).toMatch(/share the name/);
    expect(ambiguityOf(sellerInfoFromStored({ firstName: "Mary", lastName: "Hernandez" })!, two.slice(0, 1))).toBeNull();
    expect(ambiguityOf(sellerInfoFromStored({ firstName: "Jose", lastName: "Hernandez" })!, two)).toBeNull();
  });
});
