import { describe, expect, it } from "vitest";

import { MARKER, postComment } from "./comment.ts";

const TARGET = { token: "ghs_x", repository: "acme/site", sha: "abc123", apiUrl: "https://api.github.com" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake GitHub that answers by method and path, and records what was sent. */
function fakeGitHub(routes: Record<string, unknown>) {
  const calls: { call: string; body?: unknown }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const { pathname, search } = new URL(String(url));
    const call = `${init?.method ?? "GET"} ${pathname}${search}`;
    calls.push({ call, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ghs_x");
    return call in routes ? json(routes[call]) : json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return { impl, calls };
}

describe("postComment", () => {
  it("comments on the commit's pull request", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/site/commits/abc123/pulls": [{ number: 7 }],
      "GET /repos/acme/site/issues/7/comments?per_page=100": [{ id: 1, body: "Looks good" }],
      "POST /repos/acme/site/issues/7/comments": { html_url: "https://github.com/acme/site/pull/7#c2" },
    });
    expect(await postComment(TARGET, "## PersonaMark audit", github.impl)).toEqual({
      on: "pull",
      number: 7,
      url: "https://github.com/acme/site/pull/7#c2",
    });
    expect(github.calls.at(-1)?.body).toEqual({ body: `${MARKER}\n## PersonaMark audit` });
  });

  it("updates its own earlier comment instead of adding another", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/site/commits/abc123/pulls": [{ number: 7 }],
      "GET /repos/acme/site/issues/7/comments?per_page=100": [
        { id: 1, body: `${MARKER}\nold` },
        { id: 2, body: "Someone else" },
      ],
      "PATCH /repos/acme/site/issues/comments/1": { html_url: "https://github.com/acme/site/pull/7#c1" },
    });
    const posted = await postComment(TARGET, "new", github.impl);
    expect(posted).toMatchObject({ on: "pull", number: 7 });
    expect(github.calls.map((c) => c.call)).not.toContain("POST /repos/acme/site/issues/7/comments");
  });

  it("comments on the commit when no pull request has it", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/site/commits/abc123/pulls": [],
      "POST /repos/acme/site/commits/abc123/comments": { html_url: "https://github.com/acme/site/commit/abc123#c3" },
    });
    expect(await postComment(TARGET, "x", github.impl)).toEqual({
      on: "commit",
      url: "https://github.com/acme/site/commit/abc123#c3",
    });
  });

  it("throws GitHub's status and message when it refuses", async () => {
    const github = fakeGitHub({ "GET /repos/acme/site/commits/abc123/pulls": [{ number: 7 }] });
    await expect(postComment(TARGET, "x", github.impl)).rejects.toMatchObject({ status: 404 });
  });
});
