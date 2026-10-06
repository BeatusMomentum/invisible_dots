// Derived from shadcn/ui apps/v4/registry/new-york-v4/ui/skeleton.tsx at 0e3abd65, MIT; changed: the import of cn is relative.
import { cn } from "../../lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent", className)}
      {...props}
    />
  )
}

export { Skeleton }
