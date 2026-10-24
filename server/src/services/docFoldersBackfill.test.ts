import { describe, it, expect } from "vitest";
import { withLeaseFolder } from "./docFoldersBackfill.js";

describe("withLeaseFolder — the Lease folder joins a customized deal folder list once", () => {
  it("goes right after Title", () => {
    expect(withLeaseFolder(["Seller PSA", "Title", "Deeds", "Other"])).toEqual(["Seller PSA", "Title", "Lease", "Deeds", "Other"]);
  });
  it("goes just before Other when the list has no Title", () => {
    expect(withLeaseFolder(["Seller PSA", "Deeds", "Other"])).toEqual(["Seller PSA", "Deeds", "Lease", "Other"]);
  });
  it("leaves a list that already has it (any case) alone", () => {
    expect(withLeaseFolder(["Title", "lease", "Other"])).toEqual(["Title", "lease", "Other"]);
  });
  it("never adds a duplicate or reorders anything else", () => {
    const list = ["Z", "Title", "A", "Other"];
    expect(withLeaseFolder(withLeaseFolder(list))).toEqual(["Z", "Title", "Lease", "A", "Other"]);
  });
});
