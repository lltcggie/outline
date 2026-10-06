import { ProsemirrorDataHelper } from "@shared/utils/ProsemirrorDataHelper";
import type { Template } from "@server/models";
import presentUser from "./user";

function presentTemplate(template: Template) {
  return {
    id: template.id,
    url: template.path,
    urlId: template.urlId,
    title: template.title,
    // Data unfurled from external services may still be stored with mentions.
    data: template.content
      ? ProsemirrorDataHelper.removeUnfurledMentionData(template.content)
      : ProsemirrorDataHelper.getEmpty(),
    icon: template.icon,
    color: template.color,
    createdAt: template.createdAt,
    createdBy: presentUser(template.createdBy),
    updatedAt: template.updatedAt,
    updatedBy: presentUser(template.updatedBy),
    deletedAt: template.deletedAt,
    publishedAt: template.publishedAt,
    fullWidth: template.fullWidth,
    collectionId: template.collectionId,
  };
}

export default presentTemplate;
