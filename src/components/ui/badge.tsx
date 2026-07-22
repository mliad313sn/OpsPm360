import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* Pill chips per Slate & Indigo design: low-opacity semantic bg, strong fg, dot. */
const badgeVariants = cva(
  "meta inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium",
  {
    variants: {
      variant: {
        default: "bg-secondary text-secondary-foreground",
        outline: "border border-border bg-card text-muted-foreground",
        indigo: "bg-primary/10 text-primary",
        red: "bg-rag-red/10 text-rag-red",
        amber: "bg-rag-amber/10 text-rag-amber",
        green: "bg-rag-green/10 text-rag-green",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

export function Badge({ className, variant, dot, children, ...props }: BadgeProps): JSX.Element {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </div>
  );
}

export function RagBadge({
  rag,
  overridden,
}: {
  rag: "RED" | "AMBER" | "GREEN";
  overridden?: boolean;
}): JSX.Element {
  const variant = rag === "RED" ? "red" : rag === "AMBER" ? "amber" : "green";
  return (
    <Badge
      variant={variant}
      dot
      title={overridden ? "Manually overridden by steering committee" : "Algorithmic"}
    >
      {rag}
      {overridden ? "*" : ""}
    </Badge>
  );
}

/** Left-edge priority stripe for table rows / cards (design: task cards). */
export function RagStripe({ rag }: { rag: "RED" | "AMBER" | "GREEN" }): JSX.Element {
  const color =
    rag === "RED" ? "bg-rag-red" : rag === "AMBER" ? "bg-rag-amber" : "bg-rag-green";
  return <span className={cn("inline-block h-6 w-1 rounded-full align-middle", color)} aria-hidden />;
}
