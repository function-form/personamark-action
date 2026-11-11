/**
 * Posts the summary where the people who made the change will see it: on the pull request the
 * deployed commit came from, or on the commit itself when there's none. A comment this action
 * posted on a pull request before is updated rather than repeated.
 */

/** Marks our comments, so a re-run finds and updates its own. */
export const MARKER = "<!-- personamark-audit -->";

export interface CommentTarget {
  token: string;
  /** `owner/repo`. */
  repository: string;
  sha: string;
  apiUrl: string;
}

export type Commented = { on: "pull"; number: number; url: string } | { on: "commit"; url: string };

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function postComment(
  target: CommentTarget,
  markdown: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Commented> {
  const base = `${target.apiUrl.replace(/\/+$/, "")}/repos/${target.repository}`;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${target.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { message?: string };
      throw new GitHubError(response.status, detail.message ?? `HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  };

  const body = `${MARKER}\n${markdown}`;
  const pulls = await call<{ number: number }[]>("GET", `/commits/${target.sha}/pulls`);
  const pull = pulls[0];
  if (pull) {
    const comments = await call<{ id: number; body?: string }[]>(
      "GET",
      `/issues/${pull.number}/comments?per_page=100`,
    );
    const ours = comments.findLast((comment) => comment.body?.startsWith(MARKER));
    const saved = ours
      ? await call<{ html_url: string }>("PATCH", `/issues/comments/${ours.id}`, { body })
      : await call<{ html_url: string }>("POST", `/issues/${pull.number}/comments`, { body });
    return { on: "pull", number: pull.number, url: saved.html_url };
  }
  const saved = await call<{ html_url: string }>("POST", `/commits/${target.sha}/comments`, { body });
  return { on: "commit", url: saved.html_url };
}
