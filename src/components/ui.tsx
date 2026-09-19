export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={htmlFor}
        className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted"
      >
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs leading-relaxed text-muted">{hint}</p> : null}
    </div>
  );
}

const SELECT_CLASS =
  "w-full appearance-none rounded border border-line bg-paper px-3 py-2.5 text-sm text-ink " +
  "transition-colors hover:border-lineStrong focus:border-forest";

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select {...props} className={`${SELECT_CLASS} pr-9 ${props.className ?? ""}`} />
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
      >
        <path d="M5 7.5 10 12.5 15 7.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </div>
  );
}

export function Button({
  variant = "primary",
  className = "",
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded px-4 py-2.5 text-sm font-medium " +
    "transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const styles = {
    primary: "bg-forest text-white hover:bg-forest-dark",
    secondary: "border border-line bg-paper text-ink hover:border-lineStrong hover:bg-paper",
    ghost: "text-muted hover:text-ink",
  }[variant];
  return (
    <button {...props} className={`${base} ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function Card({
  title,
  children,
  action,
}: {
  title?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded border border-line bg-paper">
      {title ? (
        <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            {title}
          </h2>
          {action}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Metric({
  label,
  value,
  mono = true,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  tone?: "default" | "credit";
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        {label}
      </span>
      <span
        className={`text-sm ${
          tone === "credit" ? "font-mono font-medium text-credit" : mono ? "font-mono" : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
}