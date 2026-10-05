import type { Agent, State, Conversation } from "../shared/types.ts";
import { ensure } from "./store.ts";

export function conversation(
  state: State,
  id = state.defaultConversationId,
): Conversation {
  const item = state.conversations.find((c) => c.id === id);
  ensure(item, "CONVERSATION_NOT_FOUND", "对话不存在", 404);
  return item;
}
export function conversationId(
  state: State,
  item: { conversationId?: string },
) {
  return item.conversationId ?? state.defaultConversationId;
}
export function conversationAgents(
  state: State,
  id = state.defaultConversationId,
): Agent[] {
  return state.agents.filter((a) => conversationId(state, a) === id);
}
export function conversationBusy(state: State, id: string) {
  return (
    state.userRequests.some(
      (r) =>
        conversationId(state, r) === id &&
        !["completed", "failed", "stopped"].includes(r.status),
    ) ||
    conversationAgents(state, id).some(
      (a) =>
        a.manual ||
        ["starting", "running", "waiting", "recovery"].includes(a.status),
    )
  );
}
