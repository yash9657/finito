import Link from "next/link";
export function Brand({
  href = "/",
  className = "",
}: {
  href?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`brand ${className}`}
      aria-label="FinFlow home"
    >
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      FinFlow<span className="sr-only"> home</span>
    </Link>
  );
}
