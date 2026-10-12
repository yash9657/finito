import type { SupabaseClient } from "@supabase/supabase-js";
import type { Investigation } from "@/lib/types";
import { clipUtf8, type PriorConversation } from "./memory-context";

export interface ConversationContext {
  conversationId?: string;
  parentWorkflowId?: string;
  sourceIds?: string[];
  history: PriorConversation[];
}

/** Follow the actual parent chain, never unrelated branches or another organization's runs. */
export async function conversationContext(
  db: SupabaseClient,
  orgId: string,
  parentId?: string,
): Promise<ConversationContext> {
  if (!parentId) return { history: [] };
  const history: ConversationContext["history"] = [];
  let cursor: string | undefined = parentId;
  let parent: Investigation | undefined;
  const visited = new Set<string>();
  for (let n = 0; cursor && n < 8; n++) {
    if (visited.has(cursor))
      throw new Error(
        "Conversation history is inconsistent. Start a new question.",
      );
    visited.add(cursor);
    const result: {
      data: Investigation | null;
      error: { message: string } | null;
    } = await db
      .from("investigations")
      .select("workflow_id,org_id,conversation_id,parent_workflow_id,question,answer,source_ids,status,created_at")
      .eq("workflow_id", cursor)
      .eq("org_id", orgId)
      .maybeSingle<Investigation>();
    const data: Investigation | null = result.data;
    const error = result.error;
    if (error)
      throw new Error(
        "Conversation history could not be loaded. Retry your question.",
      );
    if (!data || data.org_id !== orgId)
      throw new Error("The earlier question is unavailable in this workspace.");
    if (!parent) {
      parent = data;
      if (data.status === "running")
        throw new Error(
          "Wait for the current answer before sending a follow-up.",
        );
    }
    // Only the immediate parent carries a short excerpt. Older turns remain discoverable
    // pointers; the complete immutable questions/answers stay in their durable records.
    history.unshift({
      workflowId: data.workflow_id,
      createdAt: data.created_at,
      question: clipUtf8(data.question, n === 0 ? 500 : 160),
      answer: n === 0 ? clipUtf8(data.answer?.prose ?? `Earlier run ended ${data.status} without an answer.`, 2000) : "",
      ...(n === 0 ? { sourceIds: data.source_ids?.slice(0, 10) ?? [] } : {}),
    });
    cursor = data.parent_workflow_id ?? undefined;
  }
  return {
    parentWorkflowId: parentId,
    conversationId: parent!.conversation_id ?? parentId,
    sourceIds: parent!.source_ids ?? undefined,
    history,
  };
}

export async function validateSourceScope(
  db: SupabaseClient,
  orgId: string,
  ids?: string[],
): Promise<void> {
  if (!ids?.length) return;
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length || ids.length > 10)
    throw new Error("Select up to ten distinct files.");
  const { data, error } = await db
    .from("data_sources")
    .select("id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .in("id", unique);
  if (error)
    throw new Error(
      "Data files could not be checked. Retry before starting a question.",
    );
  if (data?.length !== unique.length)
    throw new Error(
      "One or more selected files are unavailable in this workspace. Refresh your file selection.",
    );
}
