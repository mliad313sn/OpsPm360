import { Check } from "lucide-react";
import { GATE_ORDER } from "@/lib/gates";
import { cn } from "@/lib/utils";

const GATE_LABELS: Record<(typeof GATE_ORDER)[number], string> = {
  INTEL_GATHERING: "Intel Gathering",
  ARCH_REVIEW: "Architecture Review",
  EXECUTION: "Execution",
  HANDOVER: "Handover",
  CLOSED: "Closed",
};

/** Stage-gate stepper (design: gate_governance_audit): done ✓ · active · upcoming. */
export function GateStepper({ currentGate }: { currentGate: string }): JSX.Element {
  const activeIdx = GATE_ORDER.indexOf(currentGate as (typeof GATE_ORDER)[number]);

  return (
    <div className="glass flex flex-wrap items-start justify-between gap-2 rounded-lg px-4 py-4 md:px-8">
      {GATE_ORDER.map((gate, i) => {
        const done = activeIdx > i || currentGate === "CLOSED";
        const active = activeIdx === i && currentGate !== "CLOSED";
        return (
          <div key={gate} className="flex min-w-[100px] flex-1 flex-col items-center gap-1.5">
            <span
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-lg border text-sm font-semibold",
                done && "border-primary bg-primary text-primary-foreground",
                active && "border-2 border-primary bg-primary/10 text-primary",
                !done && !active && "border-border bg-secondary text-muted-foreground"
              )}
            >
              {done ? <Check className="h-4 w-4" aria-hidden /> : i + 1}
            </span>
            <p
              className={cn(
                "meta text-center text-xs font-medium",
                active ? "text-primary" : "text-muted-foreground"
              )}
            >
              Gate {i + 1}
            </p>
            <p className="text-center text-xs text-muted-foreground">{GATE_LABELS[gate]}</p>
          </div>
        );
      })}
    </div>
  );
}
