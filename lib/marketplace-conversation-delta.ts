import { ConversationRow, ConversationView, rowMatchesConversationView, sortConversationRows } from "./marketplace-conversation-view";

export type ConversationCursor = { updatedAt: string; id: string };

export function takeConversationChangeBatch<T>(rows: T[], limit: number) {
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

export function shouldPollConversationChanges(visibilityState: string) {
  return visibilityState === "visible";
}

export function compareConversationCursor(left: ConversationCursor, right: ConversationCursor) {
  const time = left.updatedAt.localeCompare(right.updatedAt);
  return time || left.id.localeCompare(right.id);
}

export function latestConversationCursor(rows: Array<Record<string, any>>): ConversationCursor {
  return rows.reduce<ConversationCursor>((latest, row) => {
    const candidate = { updatedAt: String(row.updated_at || "1970-01-01T00:00:00.000Z"), id: String(row.id || "") };
    return compareConversationCursor(candidate, latest) > 0 ? candidate : latest;
  }, { updatedAt: "1970-01-01T00:00:00.000Z", id: "00000000-0000-0000-0000-000000000000" });
}

export function mergeConversationDelta(
  current: ConversationRow[],
  changes: ConversationRow[],
  changedConversationIds: string[],
  view: ConversationView,
  pageSize: number,
  now = Date.now()
): ConversationRow[] {
  const changedIds = new Set(changedConversationIds);
  const changedKeys = new Set(changes.map((row) => row.groupKey));
  const retained = current.filter((row) =>
    !changedKeys.has(row.groupKey)
    && !(row.grouped_conversation_ids || [row.id]).some((id) => changedIds.has(String(id)))
  );
  return [...retained, ...changes]
    .map((row): ConversationRow => ({
      ...row,
      slaBreached: Boolean(row.requires_response)
        && now - new Date(row.last_incoming_at || row.last_message_at).getTime() >= Number(row.slaHours || 0) * 3600000
    } as ConversationRow))
    .filter((row) => rowMatchesConversationView(row, view, now))
    .sort(sortConversationRows)
    .slice(0, pageSize);
}
