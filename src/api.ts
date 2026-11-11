/** The parts of PersonaMark's `/api/v1` this action reads. */

export interface CheckGroup {
  check: string;
  title: string;
  severity: "high" | "medium" | "low";
  pages: number;
  urls: string[];
}

export interface Comparison {
  audit: { id: string; createdAt: string; score: number; partial: boolean; capped: boolean; url: string };
  comparedWith: { id: string; createdAt: string } | null;
  score: { now: number; before: number | null; change: number | null };
  areas: { area: string; label: string; now: number | null; before: number | null; change: number | null }[];
  counts: { new: number; regressed: number; recurring: number; fixed: number; newHigh: number };
  changedChecks: string[];
  new: CheckGroup[];
  regressed: CheckGroup[];
  fixed: CheckGroup[];
}

export interface Job {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string | null;
  stalled: boolean;
  error: string | null;
  auditId: string | null;
  auditUrl: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export class PersonaMark {
  readonly #base: string;

  constructor(
    baseUrl: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.#base = `${baseUrl.replace(/\/+$/, "")}/api/v1`;
  }

  async #request<T>(method: "GET" | "POST", path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, accept: "application/json" },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new ApiError(response.status, message, body);
    }
    return body as T;
  }

  /** Starts an audit, or joins the one already going. */
  async startAudit(): Promise<{ jobId: string; joined: boolean }> {
    try {
      const { jobId } = await this.#request<{ jobId: string }>("POST", "/audits");
      return { jobId, joined: false };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && typeof error.body.jobId === "string") {
        return { jobId: error.body.jobId, joined: true };
      }
      throw error;
    }
  }

  job(jobId: string): Promise<Job> {
    return this.#request("GET", `/jobs/${encodeURIComponent(jobId)}`);
  }

  compare(auditId: string): Promise<Comparison> {
    return this.#request("GET", `/audits/${encodeURIComponent(auditId)}/compare`);
  }
}
