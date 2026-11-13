// M3-03: conversion lookup by request_id, from the recorded `fx-conversion-list` (M0-03). The list's
// `request_id` filter is unverified, so the adapter also filters client-side; FX calls carry no
// x-api-version even when one is configured.
import { describe, expect, it } from "vitest";
import { blockedCalls, FetchStub, loadFixture, makeClient } from "./fixture-loader";

const recorded = loadFixture("fx-conversion-list").response.body as {
  items: { request_id: string; conversion_id: string }[];
};
const first = recorded.items[0];

describe("findConversionByRequestId", () => {
  it("returns the recorded conversion made with that request_id", async () => {
    const stub = new FetchStub().fixture("fx-conversion-list");
    const found = await makeClient(stub, { apiVersion: "2025-06-30" }).findConversionByRequestId(
      first?.request_id ?? "",
    );
    expect(found?.conversionId).toBe(first?.conversion_id);
    expect(found?.requestId).toBe(first?.request_id);
    const call = stub.calls.find((c) => c.path === "/api/v1/fx/conversions");
    expect(call?.url.searchParams.get("request_id")).toBe(first?.request_id);
    expect(call?.headers["x-api-version"]).toBeUndefined();
    expect(blockedCalls).toEqual([]);
  });

  it("returns null when no listed conversion has that request_id (a server ignoring the filter cannot return a stranger)", async () => {
    const stub = new FetchStub().fixture("fx-conversion-list");
    expect(
      await makeClient(stub).findConversionByRequestId("00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
  });
});
