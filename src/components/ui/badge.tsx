import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        red: "border-transparent bg-rag-red/15 text-rag-red",
        amber: "border-transparent bg-rag-amber/15 text-rag-amber",
        green: "border-transparent bg-rag-green/15 text-rag-green",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export function RagBadge({ rag, overridden }: { rag: "RED" | "AMBER" | "GREEN"; overridden?: boolean }): JSX.Element {
  const variant = rag === "RED" ? "red" : rag === "AMBER" ? "amber" : "green";
  return (
    <Badge variant={variant} title={overridden ? "Manually overridden by steering committee" : "Algorithmic"}>
      {rag}
      {overridden ? "*" : ""}
    </Badge>
  );
}
