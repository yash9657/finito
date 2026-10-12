import { Skeleton } from "@/components/ui/skeleton";
export default function Loading(){return <div className="page-container" role="status" aria-label="Loading workspace"><Skeleton className="mb-4 h-8 w-56"/><Skeleton className="mb-10 h-4 w-72"/><Skeleton className="h-64 w-full"/><span className="sr-only">Loading workspace</span></div>}
