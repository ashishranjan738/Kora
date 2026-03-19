interface DateDividerProps {
  label: string; // "Today", "Yesterday", "March 18, 2026"
}

export function DateDivider({ label }: DateDividerProps) {
  return (
    <div className="tl-date-divider">
      <span>{label}</span>
    </div>
  );
}

/** Convert a date string to a display label */
export function getDateLabel(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const eventDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (eventDay.getTime() === today.getTime()) return "Today";
  if (eventDay.getTime() === yesterday.getTime()) return "Yesterday";
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** Get a sortable date key (YYYY-MM-DD) */
export function getDateKey(timestamp: string): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
