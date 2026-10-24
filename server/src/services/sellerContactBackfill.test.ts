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
