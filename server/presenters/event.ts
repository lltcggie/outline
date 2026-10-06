import { ProsemirrorDataHelper } from "@shared/utils/ProsemirrorDataHelper";
import type { Event } from "@server/models";
import presentUser from "./user";

export default function presentEvent(event: Event, isAdmin = false) {
  const data = {
    id: event.id,
    name: event.name,
    modelId: event.modelId,
    userId: event.userId,
    actorId: event.actorId,
    authType: event.authType,
    actorIpAddress: event.ip || undefined,
    collectionId: event.collectionId,
    documentId: event.documentId,
    createdAt: event.createdAt,
    data: event.data,
    // Recorded content may still carry data unfurled from external services.
    changes: event.changes
      ? ProsemirrorDataHelper.removeUnfurledMentionData(event.changes)
      : undefined,
    actor: presentUser(event.actor),
  };

  if (!isAdmin) {
    delete data.changes;
    delete data.actorIpAddress;
  }

  return data;
}
