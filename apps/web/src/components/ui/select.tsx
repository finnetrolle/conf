import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(({ className, children, ...props }, ref) => {
  return (
    <div className="relative">
      <select
        className={cn(
          "h-11 w-full appearance-none rounded-2xl border border-slate-200 bg-white/85 px-4 pr-12 text-sm font-medium text-slate-900 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-200",
          className,
        )}
        ref={ref}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
    </div>
  )
})

Select.displayName = "Select"

