import SchedulerDashboard from "./components/scheduler-dashboard";

export default function Home() {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-zinc-50 font-sans text-foreground dark:bg-zinc-950">
      <SchedulerDashboard />
    </div>
  );
}
