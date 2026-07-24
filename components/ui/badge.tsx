import * as React from "react";
import { cn } from "@/lib/utils";

type BadgeVariant =
  | "default"
  | "muted"
  | "accent"
  | "warning"
  | "error"
  | "running";

const badgeVariants: Record<BadgeVariant, string> = {
  default: "border-border bg-card text-foreground",
  muted: "border-border bg-card text-muted",
  accent: "border-transparent bg-accent/15 text-accent",
  warning: "border-transparent bg-warning/15 text-warning",
  error: "border-transparent bg-error/15 text-error",
  running: "border-transparent bg-running/15 text-running",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-xs",
        badgeVariants[variant],
        className,
      )}
      {...props}
    />
  );
}
