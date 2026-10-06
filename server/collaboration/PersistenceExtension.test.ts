// @vitest-isolate true
import { randomUUID } from "node:crypto";
import type {
  afterLoadDocumentPayload,
  onStoreDocumentPayload,
} from "@hocuspocus/server";
import * as Y from "yjs";
import { ProsemirrorHelper } from "@server/models/helpers/ProsemirrorHelper";
import documentCollaborativeUpdater from "../commands/documentCollaborativeUpdater";
import PersistenceExtension from "./PersistenceExtension";

vi.mock("../commands/documentCollaborativeUpdater", () => ({
  default: vi.fn(),
}));

describe("PersistenceExtension", () => {
  it("should remove unfurled data from the live document when storing it", async () => {
    const extension = new PersistenceExtension();
    const documentId = randomUUID();
    const documentName = `document.${documentId}`;

    // Written by an outdated client, which stored the unfurled data.
    const ydoc = ProsemirrorHelper.toYDoc(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "mention",
                attrs: {
                  type: "issue",
                  id: randomUUID(),
                  modelId: randomUUID(),
                  href: "https://gitlab.com/a/b/-/issues/1",
                  label: "Secret issue",
                  unfurl: { title: "Secret issue" },
                },
              },
            ],
          },
        ],
      },
      "default"
    );

    await extension.afterLoadDocument({
      documentName,
      document: ydoc,
    } as unknown as afterLoadDocumentPayload);

    // An edit by a client flags the document as changed.
    ydoc.transact(() => ydoc.getMap("test").set("edited", true));

    const payload = {
      document: ydoc,
      context: {},
      documentName,
      clientsCount: 1,
      requestParameters: new URLSearchParams(),
    } as unknown as onStoreDocumentPayload;
    await extension.onStoreDocument(payload);

    const [mention] = ydoc
      .getXmlFragment("default")
      .createTreeWalker(
        (item) => item instanceof Y.XmlElement && item.nodeName === "mention"
      );
    expect(mention).toBeInstanceOf(Y.XmlElement);
    expect((mention as Y.XmlElement).getAttribute("unfurl")).toBeUndefined();
    expect(documentCollaborativeUpdater).toHaveBeenCalledTimes(1);

    // The server's own removal is not a change that needs to be stored again.
    await extension.onStoreDocument(payload);
    expect(documentCollaborativeUpdater).toHaveBeenCalledTimes(1);
  });
});
