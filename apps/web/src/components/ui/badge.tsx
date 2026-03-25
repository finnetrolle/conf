import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em]",
  {
    variants: {
      variant: {
        amber: "bg-orange-100 text-orange-700",
        blue: "bg-sky-100 text-sky-700",
        green: "bg-emerald-100 text-emerald-700",
        rose: "bg-rose-100 text-rose-700",
        slate: "bg-slate-100 text-slate-700",
      },
    },
    defaultVariants: {
      variant: "slate",
    },
  },
)

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}
