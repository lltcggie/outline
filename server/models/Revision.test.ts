import { createContext } from "@server/context";
import {
  buildDocument,
  buildUnfurledMentionContent,
  buildUser,
} from "@server/test/factories";
import Revision from "./Revision";

describe("#findLatest", () => {
  test("should return latest revision", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      title: "Title",
      text: "Content",
      userId: user.id,
    });
    const ctx = createContext({ user });
    await Revision.createFromDocument(ctx, document);
    document.title = "Changed 1";
    await document.save();
    await Revision.createFromDocument(ctx, document);
    document.title = "Changed 2";
    await document.save();
    await Revision.createFromDocument(ctx, document);
    const revision = await Revision.findLatest(document.id);
    expect(revision?.title).toBe("Changed 2");
  });
});

describe("#removeUnfurledMentionData", () => {
  it("should not store unfurled data in content", async () => {
    const document = await buildDocument();
    const revision = Revision.buildFromDocument(document);
    revision.content = buildUnfurledMentionContent();
    await revision.save();
    await revision.reload();

    expect(JSON.stringify(revision.content)).not.toContain("unfurl");
    expect(JSON.stringify(revision.content)).not.toContain(
      "Secret issue title"
    );
  });
});
