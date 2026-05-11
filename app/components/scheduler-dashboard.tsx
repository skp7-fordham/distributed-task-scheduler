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
      <div className="relative z-10 max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-foreground/15 bg-background shadow-lg">
        <div className="flex items-start justify-between gap-3 border-b border-foreground/10 px-6 py-4">
          <div className="space-y-1">
            <h2
              id="job-details-title"
              className="text-sm font-semibold text-foreground"
            >
              Job details
            </h2>
            <p className="text-xs text-foreground/55">
              Summary of the job record, then the full JSON payload returned by the API.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xs font-medium text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            Close
          </button>
        </div>

        <div className="max-h-[calc(85vh-5.2rem)] overflow-auto p-6">
          <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-[12rem] max-w-full">
                <div className="text-xs font-medium text-foreground/55">Job ID</div>
                <div
                  className="mt-1 break-all font-mono text-xs text-foreground/85"
                  title={job.id}
                >
                  {job.id}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {job.type ? (
                  <span
                    className="rounded-lg border border-foreground/10 bg-background px-2.5 py-1 text-xs font-mono text-foreground/80"
                    title={job.type}
                  >
                    {formatTaskTypeLabel(job.type)}
                  </span>
                ) : null}
                <PriorityBadge priority={job.priority} />
                <StatusBadge status={job.status} />
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <div className="text-xs font-medium text-foreground/55">Attempts</div>
                <div className="mt-0.5 font-mono text-sm text-foreground/85">
                  {job.attempts}/{job.maxAttempts}
                </div>
              </div>
              <div className="sm:col-span-2">
                <div className="text-xs font-medium text-foreground/55">Created (UTC)</div>
                <div className="mt-0.5 text-sm text-foreground/85">
                  {formatCreatedAt(job.createdAt)}
                </div>
              </div>
              <div className="sm:col-span-2">
                <div className="text-xs font-medium text-foreground/55">Result</div>
                <div className="mt-0.5 text-sm text-foreground/85">
                  {shortResultSummary(job)}
                </div>
              </div>
            </div>

            {job.error ? (
              <div className="mt-4 rounded-lg border border-rose-500/20 bg-rose-500/5 p-3">
                <div className="text-xs font-medium text-rose-700/90 dark:text-rose-300/90">
                  Error
                </div>
                <div className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-rose-700/80 dark:text-rose-200/80">
                  {job.error}
                </div>
              </div>
            ) : null}
          </div>

          <div className="mt-4">
            <details className="group rounded-xl border border-foreground/10 bg-background">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-foreground/80 [&::-webkit-details-marker]:hidden">
                <span className="inline-flex items-center gap-2">
                  <span className="text-foreground/55">Raw details</span>
                  <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-xs font-medium text-foreground/60">
                    JSON
                  </span>
                </span>
                <span className="text-foreground/45 transition-transform group-open:rotate-180">
                  ▼
                </span>
              </summary>
              <div className="border-t border-foreground/10 px-4 py-3">
                <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/85">
                  {formatJobDetailsJson(job)}
                </pre>
              </div>
            </details>
          </div>
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
  const accent =
    label === "Failed"
      ? "from-rose-500/25 to-rose-500/0"
      : label === "Completed"
        ? "from-emerald-500/25 to-emerald-500/0"
        : label === "Running"
          ? "from-sky-500/25 to-sky-500/0"
          : label === "Pending"
            ? "from-amber-500/25 to-amber-500/0"
            : "from-foreground/20 to-foreground/0";

  return (
    <div className="relative overflow-hidden rounded-xl border border-foreground/10 bg-background/60 px-4 py-3 shadow-sm">
      <div
        className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${accent}`}
      />
      <p className="relative text-xs font-medium text-foreground/55">{label}</p>
      <p className="relative mt-1 text-2xl font-semibold tabular-nums tracking-tight text-foreground">
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
    <div className="min-h-full bg-gradient-to-b from-foreground/[0.05] via-background to-background">
      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6 lg:gap-10 lg:py-12">
        {detailsJob ? (
          <JobDetailsModal
            job={detailsJob}
            onClose={() => setDetailsJobId(null)}
          />
        ) : null}

        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Distributed Task Scheduler
            </h1>
            <span className="inline-flex items-center rounded-full border border-foreground/10 bg-foreground/[0.04] px-3 py-1 text-xs font-medium text-foreground/65 shadow-sm">
              Live · 2s refresh
            </span>
          </div>
          <p className="max-w-2xl text-sm leading-relaxed text-foreground/60">
            Monitor queued jobs, worker execution, retries, and results.
          </p>
        </header>

        <section className="rounded-2xl border border-foreground/10 bg-background/70 p-6 shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-md sm:p-7">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Create job</h2>
            </div>
          </div>

          <form
            className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
            onSubmit={handleSubmit}
          >
            <div className="min-w-0 flex-1 basis-[220px] space-y-1.5">
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
                className="h-[42px] w-full cursor-pointer appearance-none rounded-xl border border-foreground/12 bg-background/70 bg-[length:1rem_1rem] bg-[right_0.75rem_center] bg-no-repeat px-3.5 pr-10 text-sm text-foreground shadow-sm outline-none ring-foreground/10 transition-[border-color,box-shadow] focus:border-foreground/25 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
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
            <div className="min-w-0 flex-1 basis-[160px] space-y-1.5">
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
                className="h-[42px] w-full cursor-pointer appearance-none rounded-xl border border-foreground/12 bg-background/70 bg-[length:1rem_1rem] bg-[right_0.75rem_center] bg-no-repeat px-3.5 pr-10 text-sm text-foreground shadow-sm outline-none ring-foreground/10 transition-[border-color,box-shadow] focus:border-foreground/25 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
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
              className="inline-flex h-[42px] shrink-0 items-center justify-center rounded-xl bg-foreground px-6 text-sm font-semibold text-background shadow-md shadow-black/20 ring-1 ring-white/10 transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={submitting}
            >
              Create job
            </button>
          </form>

          <p className="mt-3 text-xs leading-relaxed text-foreground/45">
            Select a task type and priority. Jobs are queued immediately and
            processed asynchronously by workers.
          </p>
        </section>

        <section className="overflow-hidden rounded-2xl border border-foreground/10 bg-background/70 shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-md">
          <div className="border-b border-foreground/10 px-5 py-4 sm:px-6">
            <h2 className="text-sm font-semibold text-foreground">Jobs</h2>
            <p className="mt-1 text-xs text-foreground/45">
              Latest job activity across the distributed queue.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 border-b border-foreground/10 px-5 py-4 sm:grid-cols-3 sm:px-6 lg:grid-cols-5">
            <MetricCard label="Total" value={jobMetrics.total} />
            <MetricCard label="Pending" value={jobMetrics.pending} />
            <MetricCard label="Running" value={jobMetrics.running} />
            <MetricCard label="Completed" value={jobMetrics.completed} />
            <MetricCard label="Failed" value={jobMetrics.failed} />
          </div>

          <div className="overflow-x-auto">
            <table className="table-fixed w-full min-w-[70rem] text-left text-[13px] leading-snug">
              <thead className="bg-foreground/[0.02]">
                <tr className="border-b border-foreground/10 text-foreground/55">
                  <th className="w-28 px-3 py-2.5 text-left text-xs font-medium text-foreground/55">
                    Job ID
                  </th>
                  <th className="w-40 px-3 py-2.5 text-left text-xs font-medium text-foreground/55">
                    Type
                  </th>
                  <th className="w-24 px-3 py-2.5 text-left text-xs font-medium text-foreground/55">
                    Priority
                  </th>
                  <th className="w-28 px-3 py-2.5 text-left text-xs font-medium text-foreground/55">
                    Status
                  </th>
                  <th className="w-24 px-3 py-2.5 text-left text-xs font-medium text-foreground/55">
                    Attempts
                  </th>
                  <th className="w-36 px-3 py-2.5 text-left text-xs font-medium text-foreground/55">
                    Error
                  </th>
                  <th className="w-40 px-3 py-2.5 text-left text-xs font-medium text-foreground/55">
                    Result
                  </th>
                  <th className="w-28 px-3 py-2.5 text-left text-xs font-medium text-foreground/55">
                    Actions
                  </th>
                  <th className="w-32 px-3 py-2.5 text-left text-xs font-medium text-foreground/55">
                    Created At (UTC)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-foreground/8">
                {sortedJobs.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-6 py-14 text-center">
                      <div className="mx-auto max-w-lg rounded-2xl border border-foreground/10 bg-foreground/[0.02] px-6 py-10">
                        <p className="text-sm font-medium text-foreground/75">
                          No jobs submitted yet.
                        </p>
                        <p className="mt-2 text-xs leading-relaxed text-foreground/55">
                          Create a task to see the distributed pipeline in action.
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  sortedJobs.map((job) => {
                    const resultLabel = shortResultSummary(job);
                    const createdLabel = formatCreatedAt(job.createdAt);
                    return (
                      <tr
                        key={job.id}
                        className="transition-colors hover:bg-foreground/[0.035]"
                      >
                        <td className="w-28 min-w-0 px-3 py-1.5 align-middle font-mono text-[12px] text-foreground/90">
                          <span
                            className="block truncate whitespace-nowrap"
                            title={job.id}
                          >
                            {formatJobIdShort(job.id)}
                          </span>
                        </td>
                        <td className="w-40 min-w-0 px-3 py-1.5 align-middle text-foreground/85">
                          {job.type ? (
                            <span
                              className="block truncate font-mono text-[12px] tracking-tight whitespace-nowrap"
                              title={job.type}
                            >
                              {job.type}
                            </span>
                          ) : (
                            <span className="text-foreground/35">—</span>
                          )}
                        </td>
                        <td className="w-24 min-w-0 overflow-hidden px-3 py-1.5 align-middle">
                          <div className="min-w-0">
                            <PriorityBadge priority={job.priority} />
                          </div>
                        </td>
                        <td className="w-28 min-w-0 overflow-hidden px-3 py-1.5 align-middle">
                          <div className="min-w-0">
                            <StatusBadge status={job.status} />
                          </div>
                        </td>
                        <td className="w-24 min-w-0 px-3 py-1.5 align-middle font-mono text-[12px] whitespace-nowrap text-foreground/75">
                          {job.attempts}/{job.maxAttempts}
                        </td>
                        <td className="w-36 min-w-0 px-3 py-1.5 align-middle text-[12px] text-rose-700/85 dark:text-rose-300/85">
                          <span
                            className="block truncate whitespace-nowrap"
                            title={job.error ?? undefined}
                          >
                            {formatErrorSummary(job)}
                          </span>
                        </td>
                        <td className="w-40 min-w-0 px-3 py-1.5 align-middle text-[12px] text-foreground/80">
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
                        <td className="w-28 min-w-0 px-3 py-1.5 align-middle">
                          <button
                            type="button"
                            onClick={() => setDetailsJobId(job.id)}
                            className="inline-flex max-w-full items-center justify-center truncate rounded-lg border border-foreground/10 bg-foreground/[0.04] px-2.5 py-1 text-left text-[12px] font-semibold whitespace-nowrap text-foreground/80 shadow-sm transition hover:bg-foreground/[0.07] hover:text-foreground"
                            title="View full job JSON"
                          >
                            View details
                          </button>
                        </td>
                        <td className="w-32 min-w-0 px-3 py-1.5 align-middle text-[12px] whitespace-nowrap text-foreground/60 tabular-nums">
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
    </div>
  );
}
