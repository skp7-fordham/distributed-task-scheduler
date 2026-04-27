"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

/** Same-origin path; Next.js rewrites to the Express server (see `next.config.js`). */
const JOBS_URL = "/api/jobs";

export const TASK_TYPES = [
  "report_generation",
  "data_processing",
  "email_batch",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export type JobStatus = "pending" | "running" | "completed" | "failed";

export type Job = {
  id: string;
  type: TaskType | null;
  status: JobStatus;
  createdAt: Date;
  result: unknown | null;
  attempts: number;
  maxAttempts: number;
  error: string | null;
};

function isTaskType(value: string): value is TaskType {
  return (TASK_TYPES as readonly string[]).includes(value);
}

function formatTaskTypeLabel(type: TaskType) {
  return type
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Fixed locale + timezone so SSR and the browser produce identical strings (avoids hydration mismatch). */
function formatCreatedAt(d: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(d);
}

function isJobStatus(value: string): value is JobStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed"
  );
}

function parseJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : null;
  if (!id) return null;
  const status =
    typeof o.status === "string" && isJobStatus(o.status)
      ? o.status
      : "pending";
  const createdAt =
    typeof o.createdAt === "string" ? new Date(o.createdAt) : new Date(NaN);
  if (Number.isNaN(createdAt.getTime())) return null;
  const type =
    typeof o.type === "string" && isTaskType(o.type) ? o.type : null;
  const result = "result" in o ? (o.result as unknown) : null;
  const attempts = Number.isInteger(o.attempts) ? (o.attempts as number) : 0;
  const maxAttempts = Number.isInteger(o.maxAttempts)
    ? (o.maxAttempts as number)
    : 3;
  const error =
    typeof o.error === "string" && o.error.trim() ? o.error : null;
  return { id, type, status, createdAt, result, attempts, maxAttempts, error };
}

/** One-line summary for the Result column (aligned with worker result shapes). */
function formatResultSummary(job: Job): string {
  const { status, result } = job;

  if (status === "failed" && result && typeof result === "object") {
    const err = (result as Record<string, unknown>).error;
    if (typeof err === "string" && err.trim()) {
      return err.length > 96 ? `${err.slice(0, 93)}…` : err;
    }
  }

  if (status === "completed" && result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const kind = typeof r.kind === "string" ? r.kind : "";

    if (kind === "report_generation") {
      const pages =
        typeof r.pageCount === "number" ? r.pageCount : "?";
      const fmt = typeof r.format === "string" ? r.format : "pdf";
      return `${String(fmt).toUpperCase()} · ${pages} pages · ${typeof r.reportId === "string" ? r.reportId : "report"}`;
    }
    if (kind === "data_processing") {
      const out =
        typeof r.outputRows === "number"
          ? r.outputRows.toLocaleString("en-US")
          : "?";
      const inn =
        typeof r.inputRows === "number"
          ? r.inputRows.toLocaleString("en-US")
          : "?";
      return `${inn} → ${out} rows`;
    }
    if (kind === "email_batch") {
      const sent = typeof r.sent === "number" ? r.sent : "?";
      const bounced =
        typeof r.bounced === "number" ? r.bounced : 0;
      return `${sent} sent, ${bounced} bounced`;
    }

    try {
      return JSON.stringify(result);
    } catch {
      return "—";
    }
  }

  return "—";
}

function formatErrorSummary(job: Job): string {
  if (!job.error) return "—";
  return job.error.length > 96 ? `${job.error.slice(0, 93)}…` : job.error;
}

function StatusBadge({ status }: { status: JobStatus }) {
  const styles: Record<JobStatus, string> = {
    pending:
      "bg-amber-500/10 text-amber-800 ring-amber-500/20 dark:text-amber-200 dark:ring-amber-400/30",
    running:
      "bg-sky-500/10 text-sky-800 ring-sky-500/20 dark:text-sky-200 dark:ring-sky-400/30",
    completed:
      "bg-emerald-500/10 text-emerald-800 ring-emerald-500/20 dark:text-emerald-200 dark:ring-emerald-400/30",
    failed:
      "bg-rose-500/10 text-rose-800 ring-rose-500/20 dark:text-rose-200 dark:ring-rose-400/30",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums ring-1 ring-inset ${styles[status]}`}
    >
      {status}
    </span>
  );
}

export default function SchedulerDashboard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [taskType, setTaskType] = useState<TaskType>(TASK_TYPES[0]);
  const [submitting, setSubmitting] = useState(false);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch(JOBS_URL);
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (!Array.isArray(data)) return;
      const parsed = data
        .map(parseJob)
        .filter((j): j is Job => j !== null);
      setJobs(parsed);
    } catch {
      /* Backend offline or proxy error */
    }
  }, []);

  useEffect(() => {
    void loadJobs();
    const interval = window.setInterval(() => {
      void loadJobs();
    }, 2000);
    return () => window.clearInterval(interval);
  }, [loadJobs]);

  const sortedJobs = useMemo(
    () => [...jobs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    [jobs],
  );

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    try {
      const res = await fetch(JOBS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: taskType }),
      });
      if (!res.ok) return;
      await loadJobs();
    } catch {
      /* Network error */
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-10 px-4 py-12 sm:px-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Task scheduler
        </h1>
        <p className="text-sm text-foreground/55">
          Queue and monitor distributed jobs via the local API. Jobs refresh
          every 2 seconds.
        </p>
      </header>

      <section className="rounded-2xl border border-foreground/10 bg-background/80 p-6 shadow-sm backdrop-blur-sm">
        <h2 className="text-sm font-medium text-foreground/80">Submit job</h2>
        <form
          className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={handleSubmit}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <label
              htmlFor="task-type"
              className="text-xs font-medium text-foreground/55"
            >
              Task type
            </label>
            <select
              id="task-type"
              name="type"
              value={taskType}
              onChange={(e) => setTaskType(e.target.value as TaskType)}
              disabled={submitting}
              className="h-[42px] w-full cursor-pointer appearance-none rounded-xl border border-foreground/12 bg-background bg-[length:1rem_1rem] bg-[right_0.75rem_center] bg-no-repeat px-3.5 pr-10 text-sm text-foreground outline-none ring-foreground/10 transition-[border-color,box-shadow] focus:border-foreground/25 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23666'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`,
              }}
            >
              {TASK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {formatTaskTypeLabel(t)}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="inline-flex h-[42px] shrink-0 items-center justify-center rounded-xl bg-foreground px-5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={submitting}
          >
            Submit
          </button>
        </form>
      </section>

      <section className="overflow-hidden rounded-2xl border border-foreground/10 bg-background/80 shadow-sm backdrop-blur-sm">
        <div className="border-b border-foreground/10 px-6 py-4">
          <h2 className="text-sm font-medium text-foreground/80">Jobs</h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-foreground/10 text-foreground/45">
                <th className="px-6 py-3 font-medium">Job ID</th>
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Attempts</th>
                <th className="min-w-[220px] px-6 py-3 font-medium">Error</th>
                <th className="min-w-[200px] px-6 py-3 font-medium">Result</th>
                <th className="px-6 py-3 font-medium">Created At (UTC)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-foreground/8">
              {sortedJobs.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-6 py-12 text-center text-sm text-foreground/45"
                  >
                    No jobs yet. Submit one above.
                  </td>
                </tr>
              ) : (
                sortedJobs.map((job) => (
                  <tr
                    key={job.id}
                    className="transition-colors hover:bg-foreground/[0.03]"
                  >
                    <td className="px-6 py-3.5 font-mono text-xs text-foreground/90">
                      {job.id}
                    </td>
                    <td className="px-6 py-3.5 text-foreground/85">
                      {job.type ? (
                        <span className="font-mono text-xs tracking-tight">
                          {job.type}
                        </span>
                      ) : (
                        <span className="text-foreground/35">—</span>
                      )}
                    </td>
                    <td className="px-6 py-3.5">
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="px-6 py-3.5 font-mono text-xs text-foreground/75">
                      {job.attempts}/{job.maxAttempts}
                    </td>
                    <td className="max-w-[280px] px-6 py-3.5 text-xs leading-snug text-rose-700/85 dark:text-rose-300/85">
                      <span className="line-clamp-2" title={job.error ?? undefined}>
                        {formatErrorSummary(job)}
                      </span>
                    </td>
                    <td className="max-w-[280px] px-6 py-3.5 text-xs leading-snug text-foreground/70">
                      <span
                        className="line-clamp-2"
                        title={
                          job.status === "completed" || job.status === "failed"
                            ? formatResultSummary(job)
                            : undefined
                        }
                      >
                        {formatResultSummary(job)}
                      </span>
                    </td>
                    <td className="px-6 py-3.5 text-foreground/60 tabular-nums">
                      {formatCreatedAt(job.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
