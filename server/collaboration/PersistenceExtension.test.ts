// @vitest-isolate true
import { randomUUID } from "node:crypto";
import type {
  afterLoadDocumentPayload,
  Connection,
  onStoreDocumentPayload,
} from "@hocuspocus/server";
import * as Y from "yjs";
import { Day } from "@shared/utils/time";
import Document from "@server/models/Document";
import { ProsemirrorHelper } from "@server/models/helpers/ProsemirrorHelper";
import Redis from "@server/storage/redis";
import documentCollaborativeUpdater from "../commands/documentCollaborativeUpdater";
import PersistenceExtension from "./PersistenceExtension";

vi.mock("../commands/documentCollaborativeUpdater", () => ({
  default: vi.fn(),
}));

describe("PersistenceExtension", () => {
  it("should attribute a store to the editor when removing unfurled data", async () => {
    const extension = new PersistenceExtension();
    const documentId = randomUUID();
    const documentName = `document.${documentId}`;
    const editorId = randomUUID();
    const otherId = randomUUID();

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

    const connection = {
      context: { user: { id: editorId } },
    } as unknown as Connection;
    ydoc.transact(() => ydoc.getMap("test").set("edited", true), connection);

    // Another user edits the same document through another server afterwards,
    // so they are the latest editor known to Redis.
    await Redis.defaultClient.zaddWithSequence(
      Document.getCollaboratorKey(documentId),
      otherId,
      Day.seconds
    );

    await extension.onStoreDocument({
      document: ydoc,
      context: {},
      documentName,
      clientsCount: 1,
      requestParameters: new URLSearchParams(),
    } as unknown as onStoreDocumentPayload);

    const [mention] = ydoc
      .getXmlFragment("default")
      .createTreeWalker(
        (item) => item instanceof Y.XmlElement && item.nodeName === "mention"
      );
    expect(mention).toBeInstanceOf(Y.XmlElement);
    expect((mention as Y.XmlElement).getAttribute("unfurl")).toBeUndefined();

    const [[props]] = vi.mocked(documentCollaborativeUpdater).mock.calls;
    expect(props.collaborators.ids.at(-1)).toEqual(editorId);
  });
});
