import { InvestigationView } from "@/components/investigation/InvestigationView";

/**
 * `/investigations/[id]` — the transcript (Plan 5 §9).
 *
 * A thin server shell: the view is a client component because it holds a Realtime subscription,
 * and the org scoping it depends on lives in the API route it calls, not here.
 */
export default async function InvestigationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <InvestigationView id={id} />;
}
