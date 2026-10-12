import * as React from "react";
import { cn } from "@/lib/utils";

type Variant =
  | "default"
  | "accent"
  | "outline"
  | "ghost"
  | "warning"
  | "destructive";
type Size = "default" | "sm" | "lg" | "icon";

const variants: Record<Variant, string> = {
  default: "border border-border bg-card text-foreground hover:bg-border",
  accent: "bg-accent text-on-accent hover:opacity-90",
  outline: "border border-border bg-transparent text-foreground hover:bg-card",
  ghost: "bg-transparent text-foreground hover:bg-card",
  warning: "bg-warning text-on-accent hover:opacity-90",
  destructive: "bg-error text-on-accent hover:opacity-90",
};

const sizes: Record<Size, string> = {
  default: "min-h-11 px-4 py-2",
  sm: "min-h-9 px-3 text-sm",
  lg: "min-h-12 px-6",
  icon: "h-11 w-11",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({
  className,
  variant = "default",
  size = "default",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
