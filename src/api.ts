/** The parts of PersonaMark's `/api/v1` this action reads. */

export interface CheckGroup {
  check: string;
  title: string;
  severity: "high" | "medium" | "low";
  pages: number;
  urls: string[];
}

/** What a comparison holds, for an audit of the site or for a preview. */
export interface ComparisonCore {
  comparedWith: { id: string; createdAt: string } | null;
  score: { now: number; before: number | null; change: number | null };
  areas: { area: string; label: string; now: number | null; before: number | null; change: number | null }[];
  counts: { new: number; regressed: number; recurring: number; fixed: number; newHigh: number };
  changedChecks: string[];
  new: CheckGroup[];
  regressed: CheckGroup[];
  fixed: CheckGroup[];
}

export interface Comparison extends ComparisonCore {
  audit: { id: string; createdAt: string; score: number; partial: boolean; capped: boolean; url: string };
}

export interface PreviewComparison extends ComparisonCore {
  preview: {
    id: string;
    createdAt: string;
    previewOrigin: string;
    ref: string | null;
    sha: string | null;
    pullRequest: number | null;
    partial: boolean;
    capped: boolean;
  };
  /** The production audit it was compared with, in PersonaMark. */
  productionAuditUrl: string | null;
}

export interface Preview {
  id: string;
  jobId: string;
  status: Job["status"];
  stage: string | null;
  stalled: boolean;
  error: string | null;
  score: number | null;
  productionScore: number | null;
}

export interface PreviewRequest {
  url: string;
  ref?: string;
  sha?: string;
  pull_request?: number;
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

  async #request<T>(method: "GET" | "POST", path: string, data?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.#base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.key}`,
        accept: "application/json",
        ...(data === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
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

  /** Starts a preview audit, or joins the one of the same preview already going. */
  async startPreview(request: PreviewRequest): Promise<{ previewId: string; joined: boolean }> {
    try {
      const { previewId } = await this.#request<{ previewId: string }>("POST", "/previews", request);
      return { previewId, joined: false };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && typeof error.body.previewId === "string") {
        return { previewId: error.body.previewId, joined: true };
      }
      throw error;
    }
  }

  preview(previewId: string): Promise<Preview> {
    return this.#request("GET", `/previews/${encodeURIComponent(previewId)}`);
  }

  comparePreview(previewId: string): Promise<PreviewComparison> {
    return this.#request("GET", `/previews/${encodeURIComponent(previewId)}/compare`);
  }
}
