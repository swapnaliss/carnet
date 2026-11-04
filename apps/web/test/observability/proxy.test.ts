// The proxy assigns the correlation id for every page and API request (M1-09 composed into M1-10's
// proxy): a safe inbound x-request-id is kept, anything else is replaced, and the id is forwarded on
// the request (Next exposes forwarded request headers as `x-middleware-request-<name>`) and set on
// the response.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "../../src/proxy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function run(id?: string) {
  const res = proxy(
    new NextRequest("http://localhost/ops", id ? { headers: { "x-request-id": id } } : {}),
  );
  return {
    response: res.headers.get("x-request-id"),
    forwarded: res.headers.get("x-middleware-request-x-request-id"),
  };
}

describe("proxy: x-request-id", () => {
  it("keeps a safe inbound id on the request and the response", () => {
    expect(run("trace-0001-abcd")).toEqual({
      response: "trace-0001-abcd",
      forwarded: "trace-0001-abcd",
    });
  });

  it.each(["bad id; x=1", "<b>", "short"])("replaces %j with one new UUID", (bad) => {
    const { response, forwarded } = run(bad);
    expect(response).toMatch(UUID);
    expect(forwarded).toBe(response);
  });

  it("assigns an id when none is sent", () => {
    const { response, forwarded } = run();
    expect(response).toMatch(UUID);
    expect(forwarded).toBe(response);
  });
});
