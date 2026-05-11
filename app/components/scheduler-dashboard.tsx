"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

/** Same-origin API proxy (see `next.config.js` rewrite for `/api/jobs`). */
const JOBS_URL = "/api/jobs";

export const TASK_TYPES = [
  "report_generation",
  "data_processing",
  "email_batch",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const JOB_PRIORITIES = ["high", "normal", "low"] as const;

export type JobPriority = (typeof JOB_PRIORITIES)[number];

export type JobStatus = "pending" | "running" | "completed" | "failed";

export type Job = {
  id: string;
  type: TaskType | null;
  status: JobStatus;
  priority: JobPriority;
  createdAt: Date;
  result: unknown | null;
  attempts: number;
  maxAttempts: number;
  error: string | null;
};

function isTaskType(value: string): value is TaskType {
  return (TASK_TYPES as readonly string[]).includes(value);
}

function isJobPriority(value: string): value is JobPriority {
  return (JOB_PRIORITIES as readonly string[]).includes(value);
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

/** Table display: first 8 chars + "..." (full id in title). */
function formatJobIdShort(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 8)}...`;
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
  const priorityRaw =
    typeof o.priority === "string" && isJobPriority(o.priority)
      ? o.priority
      : "normal";
  const result = "result" in o ? (o.result as unknown) : null;
  const attempts = Number.isInteger(o.attempts) ? (o.attempts as number) : 0;
  const maxAttempts = Number.isInteger(o.maxAttempts)
    ? (o.maxAttempts as number)
    : 3;
  const error =
    typeof o.error === "string" && o.error.trim() ? o.error : null;
  return {
    id,
    type,
    status,
    priority: priorityRaw,
    createdAt,
    result,
    attempts,
    maxAttempts,
    error,
  };
}

/** One-line label for the Result column (details live in the modal). */
function shortResultSummary(job: Job): string {
  const { result, status, type } = job;
  if (status === "failed") {
    return "Failed";
  }
  if (result === null || result === undefined) {
    return "-";
  }
  if (status === "completed") {
    let key: string | null = null;
    if (typeof result === "object" && result !== null && "kind" in result) {
      const kind = (result as Record<string, unknown>).kind;
      if (typeof kind === "string") key = kind;
    }
    if (!key && type) key = type;
    if (key === "data_processing") return "CSV processed";
    if (key === "report_generation") return "Report generated";
    if (key === "email_batch") return "Email batch completed";
    return "Completed";
  }
  return "-";
}

function jobDetailsPayload(job: Job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    priority: job.priority,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: job.error,
    result: job.result,
    createdAt: job.createdAt.toISOString(),
  };
}

function formatJobDetailsJson(job: Job): string {
  try {
    return JSON.stringify(jobDetailsPayload(job), null, 2);
  } catch {
    return "(could not serialize)";
  }
}

function JobDetailsModal({
  job,
  onClose,
}: {
  job: Job;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="job-details-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
        aria-label="Close dialog"
        onClick={onClose}
      />
      <div className="relative z-10 max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-foreground/15 bg-background shadow-lg">
        <div className="flex items-center justify-between border-b border-foreground/10 px-5 py-4">
          <h2
            id="job-details-title"
            className="text-sm font-semibold text-foreground"
          >
            Job details
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xs font-medium text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            Close
          </button>
        </div>
        <div className="max-h-[calc(85vh-4.5rem)] overflow-auto p-5">
          <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/85">
            {formatJobDetailsJson(job)}
          </pre>
        </div>
      </div>
    </div>
  );
}

function formatErrorSummary(job: Job): string {
  if (!job.error) return "—";
  return job.error;
}

function formatPriorityLabel(p: JobPriority) {
  return p.charAt(0).toUpperCase() + p.slice(1);
}

function PriorityBadge({ priority }: { priority: JobPriority }) {
  const styles: Record<JobPriority, string> = {
    high:
      "bg-violet-500/12 text-violet-900 ring-violet-500/25 dark:text-violet-100 dark:ring-violet-400/35",
    normal:
      "bg-foreground/[0.06] text-foreground/75 ring-foreground/12 dark:text-foreground/70",
    low:
      "bg-slate-500/10 text-slate-700 ring-slate-500/20 dark:text-slate-300 dark:ring-slate-400/25",
  };

  return (
    <span
      className={`inline-flex max-w-full min-w-0 items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ring-1 ring-inset ${styles[priority]}`}
    >
      {formatPriorityLabel(priority)}
    </span>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-foreground/10 bg-background/60 px-4 py-3">
      <p className="text-xs font-medium text-foreground/50">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums tracking-tight text-foreground">
        {value.toLocaleString("en-US")}
      </p>
    </div>
  );
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
      className={`inline-flex max-w-full min-w-0 items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ring-1 ring-inset ${styles[status]}`}
    >
      {status}
    </span>
  );
}

export default function SchedulerDashboard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [taskType, setTaskType] = useState<TaskType>(TASK_TYPES[0]);
  const [priority, setPriority] = useState<JobPriority>("normal");
  const [submitting, setSubmitting] = useState(false);
  const [detailsJobId, setDetailsJobId] = useState<string | null>(null);

  const detailsJob = useMemo(
    () => jobs.find((j) => j.id === detailsJobId) ?? null,
    [jobs, detailsJobId],
  );

  useEffect(() => {
    if (!detailsJobId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailsJobId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailsJobId]);

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

  const jobMetrics = useMemo(() => {
    let pending = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;
    for (const job of jobs) {
      switch (job.status) {
        case "pending":
          pending += 1;
          break;
        case "running":
          running += 1;
          break;
        case "completed":
          completed += 1;
          break;
        case "failed":
          failed += 1;
          break;
        default:
          break;
      }
    }
    return {
      total: jobs.length,
      pending,
      running,
      completed,
      failed,
    };
  }, [jobs]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    try {
      const res = await fetch(JOBS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: taskType, priority }),
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
    <div className="relative mx-auto flex min-h-full w-full max-w-4xl flex-col gap-10 px-4 py-12 sm:px-6">
      {detailsJob ? (
        <JobDetailsModal
          job={detailsJob}
          onClose={() => setDetailsJobId(null)}
        />
      ) : null}
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
          className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
          onSubmit={handleSubmit}
        >
          <div className="min-w-0 flex-1 basis-[200px] space-y-1.5">
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
          <div className="min-w-0 flex-1 basis-[140px] space-y-1.5">
            <label
              htmlFor="job-priority"
              className="text-xs font-medium text-foreground/55"
            >
              Priority
            </label>
            <select
              id="job-priority"
              name="priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as JobPriority)}
              disabled={submitting}
              className="h-[42px] w-full cursor-pointer appearance-none rounded-xl border border-foreground/12 bg-background bg-[length:1rem_1rem] bg-[right_0.75rem_center] bg-no-repeat px-3.5 pr-10 text-sm text-foreground outline-none ring-foreground/10 transition-[border-color,box-shadow] focus:border-foreground/25 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23666'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`,
              }}
            >
              {JOB_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {formatPriorityLabel(p)}
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

        <div className="grid grid-cols-2 gap-3 border-b border-foreground/10 px-6 py-4 sm:grid-cols-3 lg:grid-cols-5">
          <MetricCard label="Total" value={jobMetrics.total} />
          <MetricCard label="Pending" value={jobMetrics.pending} />
          <MetricCard label="Running" value={jobMetrics.running} />
          <MetricCard label="Completed" value={jobMetrics.completed} />
          <MetricCard label="Failed" value={jobMetrics.failed} />
        </div>

        <div className="overflow-x-auto">
          <table className="table-fixed w-full min-w-[70rem] text-left text-sm">
            <thead>
              <tr className="border-b border-foreground/10 text-foreground/45">
                <th className="w-28 px-2.5 py-2 text-xs font-medium">
                  Job ID
                </th>
                <th className="w-40 px-2.5 py-2 text-xs font-medium">Type</th>
                <th className="w-24 px-2.5 py-2 text-xs font-medium">
                  Priority
                </th>
                <th className="w-28 px-2.5 py-2 text-xs font-medium">Status</th>
                <th className="w-24 px-2.5 py-2 text-xs font-medium">
                  Attempts
                </th>
                <th className="w-36 px-2.5 py-2 text-xs font-medium">Error</th>
                <th className="w-40 px-2.5 py-2 text-xs font-medium">Result</th>
                <th className="w-28 px-2.5 py-2 text-xs font-medium">Actions</th>
                <th className="w-32 px-2.5 py-2 text-xs font-medium">
                  Created At (UTC)
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-foreground/8">
              {sortedJobs.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-12 text-center text-sm text-foreground/45"
                  >
                    No jobs yet. Submit one above.
                  </td>
                </tr>
              ) : (
                sortedJobs.map((job) => {
                  const resultLabel = shortResultSummary(job);
                  const createdLabel = formatCreatedAt(job.createdAt);
                  return (
                  <tr
                    key={job.id}
                    className="transition-colors hover:bg-foreground/[0.03]"
                  >
                    <td className="w-28 min-w-0 px-2.5 py-2 align-middle font-mono text-xs text-foreground/90">
                      <span
                        className="block truncate whitespace-nowrap"
                        title={job.id}
                      >
                        {formatJobIdShort(job.id)}
                      </span>
                    </td>
                    <td className="w-40 min-w-0 px-2.5 py-2 align-middle text-foreground/85">
                      {job.type ? (
                        <span
                          className="block truncate font-mono text-xs tracking-tight whitespace-nowrap"
                          title={job.type}
                        >
                          {job.type}
                        </span>
                      ) : (
                        <span className="text-foreground/35">—</span>
                      )}
                    </td>
                    <td className="w-24 min-w-0 overflow-hidden px-2.5 py-2 align-middle">
                      <div className="min-w-0">
                        <PriorityBadge priority={job.priority} />
                      </div>
                    </td>
                    <td className="w-28 min-w-0 overflow-hidden px-2.5 py-2 align-middle">
                      <div className="min-w-0">
                        <StatusBadge status={job.status} />
                      </div>
                    </td>
                    <td className="w-24 min-w-0 px-2.5 py-2 align-middle font-mono text-xs whitespace-nowrap text-foreground/75">
                      {job.attempts}/{job.maxAttempts}
                    </td>
                    <td className="w-36 min-w-0 px-2.5 py-2 align-middle text-xs text-rose-700/85 dark:text-rose-300/85">
                      <span
                        className="block truncate whitespace-nowrap"
                        title={job.error ?? undefined}
                      >
                        {formatErrorSummary(job)}
                      </span>
                    </td>
                    <td className="w-40 min-w-0 px-2.5 py-2 align-middle text-xs text-foreground/80">
                      <span
                        className={`block truncate whitespace-nowrap ${
                          resultLabel === "-" ? "text-foreground/35" : ""
                        }`}
                        title={
                          resultLabel !== "-" ? resultLabel : undefined
                        }
                      >
                        {resultLabel}
                      </span>
                    </td>
                    <td className="w-28 min-w-0 px-2.5 py-2 align-middle">
                      <button
                        type="button"
                        onClick={() => setDetailsJobId(job.id)}
                        className="max-w-full truncate text-left text-xs font-medium whitespace-nowrap text-foreground/70 underline decoration-foreground/25 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/50"
                        title="View full job JSON"
                      >
                        View details
                      </button>
                    </td>
                    <td className="w-32 min-w-0 px-2.5 py-2 align-middle text-xs whitespace-nowrap text-foreground/60 tabular-nums">
                      <span className="block truncate" title={createdLabel}>
                        {createdLabel}
                      </span>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
