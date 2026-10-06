import { ProsemirrorDataHelper } from "@shared/utils/ProsemirrorDataHelper";
import { Hour } from "@shared/utils/time";
import type Collection from "@server/models/Collection";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import type { APIContext } from "@server/types";
import presentUser from "./user";

type Options = {
  /** Whether to render the collection's public fields. */
  isPublic?: boolean;
  /** The root share ID when presenting a shared collection. */
  shareId?: string;
  /** Whether to include the updatedAt timestamp. */
  includeUpdatedAt?: boolean;
  /** Always include the markdown description in the payload. */
  includeText?: boolean;
  /** Always include the data of the collection in the payload. */
  includeData?: boolean;
};

export default async function presentCollection(
  ctx: APIContext | undefined,
  collection: Collection,
  options: Options = {}
) {
  const asData = !ctx || Number(ctx?.headers["x-api-version"] ?? 0) >= 3;

  const res: Record<string, unknown> = {
    id: collection.id,
    url: collection.path,
    urlId: collection.urlId,
    name: collection.name,
    data:
      options.includeData === false
        ? undefined
        : asData || options.includeData
          ? await DocumentHelper.toJSON(
              collection,
              options.isPublic
                ? {
                    signedUrls: Hour.seconds,
                    teamId: collection.teamId,
                    internalUrlBase: `/s/${options.shareId}`,
                  }
                : undefined
            )
          : undefined,
    description:
      !asData || options.includeText
        ? await presentDescription(collection)
        : undefined,
    sort: collection.sort,
    icon: collection.icon,
    color: collection.color,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
    archivedBy: undefined,
  };

  if (options.isPublic && !options.includeUpdatedAt) {
    delete res.updatedAt;
  }

  if (!options.isPublic) {
    res.index = collection.index;
    res.sharing = collection.sharing;
    res.commenting = collection.commenting;
    res.templateManagement = collection.templateManagement;
    res.permission = collection.permission;
    res.deletedAt = collection.deletedAt;
    res.archivedAt = collection.archivedAt;
    res.deprecatedReason = collection.deprecatedReason;
    res.archivedBy =
      collection.archivedBy && presentUser(collection.archivedBy);
    res.sourceMetadata = collection.sourceMetadata
      ? {
          externalId: collection.sourceMetadata.externalId,
          externalName: collection.sourceMetadata.externalName,
          createdByName: collection.sourceMetadata.createdByName,
        }
      : undefined;
  }

  return res;
}

/**
 * Presents the markdown description of a collection. A description stored
 * before unfurled data was removed from mentions may contain the titles of
 * external resources, so it is regenerated from the cleaned content then.
 *
 * @param collection the collection to present.
 * @returns the markdown description.
 */
async function presentDescription(collection: Collection) {
  if (!collection.content) {
    return collection.description;
  }

  const content = ProsemirrorDataHelper.removeUnfurledMentionData(
    collection.content
  );
  if (content === collection.content) {
    return collection.description;
  }

  return DocumentHelper.toMarkdown(content, { includeTitle: false });
}
