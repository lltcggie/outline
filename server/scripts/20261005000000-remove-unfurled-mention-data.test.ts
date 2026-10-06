// @vitest-isolate true
import { IntegrationService, IntegrationType } from "@shared/types";
import {
  Collection,
  Comment,
  Document,
  Integration,
  IntegrationAuthentication,
  Revision,
} from "@server/models";
import { ProsemirrorHelper } from "@server/models/helpers/ProsemirrorHelper";
import { sequelize } from "@server/storage/database";
import {
  buildCollection,
  buildComment,
  buildDocument,
  buildUser,
} from "@server/test/factories";
import script from "./20261005000000-remove-unfurled-mention-data";

// The database and Redis are already connected by the test setup.
vi.mock("./bootstrap", () => ({}));

const href = "https://gitlab.example.com/secret/p/-/issues/1";
const title = "Secret issue title";

const content = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "mention",
          attrs: {
            id: "0c440212-8b40-49fa-8a64-2548d6b60d59",
            modelId: "c85a0d80-3a89-4b25-a0cd-e7fc83f0d226",
            type: "issue",
            label: title,
            href,
            unfurl: { title, description: "Secret body" },
          },
        },
      ],
    },
  ],
};

/**
 * Writes a column directly, bypassing the model hooks that would clean it.
 *
 * @param table the table to write.
 * @param id the row id.
 * @param values the column values.
 */
async function writeRaw(
  table: string,
  id: string,
  values: Record<string, unknown>
) {
  const columns = Object.keys(values)
    .map((key) => `"${key}" = :${key}`)
    .join(", ");
  await sequelize.query(`UPDATE ${table} SET ${columns} WHERE id = :id`, {
    replacements: { ...values, id },
  });
}

describe("remove-unfurled-mention-data", () => {
  it("should remove unfurled data from stored content", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      userId: user.id,
      teamId: user.teamId,
    });
    const revision = Revision.buildFromDocument(document);
    await revision.save();
    const comment = await buildComment({
      userId: user.id,
      documentId: document.id,
    });
    const collection = await buildCollection({
      userId: user.id,
      teamId: user.teamId,
    });

    const state = ProsemirrorHelper.toState(ProsemirrorHelper.toYDoc(content));
    expect(state.toString("latin1")).toContain("Secret body");

    const json = JSON.stringify(content);
    await writeRaw("documents", document.id, {
      content: json,
      text: `@[${title}](${href})`,
      state,
    });
    await writeRaw("revisions", revision.id, { content: json });
    await writeRaw("comments", comment.id, { data: json });
    await writeRaw("collections", collection.id, {
      content: json,
      description: title,
    });

    const dryRun = await script({ dryRun: true });
    expect(dryRun.documents).toBeGreaterThanOrEqual(1);
    expect(
      JSON.stringify(
        (await Document.unscoped().findByPk(document.id, { paranoid: false }))
          ?.content
      )
    ).toContain(title);

    await script();

    const cleaned = await Document.unscoped().findByPk(document.id, {
      attributes: ["id", "content", "text", "state"],
      rejectOnEmpty: true,
    });
    expect(JSON.stringify(cleaned.content)).not.toContain(title);
    expect(JSON.stringify(cleaned.content)).not.toContain("unfurl");
    expect(cleaned.text).not.toContain(title);
    expect(Buffer.from(cleaned.state!).toString("latin1")).not.toContain(title);
    expect(
      ProsemirrorHelper.removeUnfurledMentionDataFromState(cleaned.state!)
    ).toBeUndefined();

    const [{ count }] = await sequelize.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM documents WHERE id = :id AND "searchVector" @@ to_tsquery('english', 'secret & title')`,
      { type: "SELECT" as never, replacements: { id: document.id } }
    );
    expect(Number(count)).toEqual(0);

    await revision.reload();
    expect(JSON.stringify(revision.content)).not.toContain(title);

    const reloadedComment = await Comment.findByPk(comment.id, {
      rejectOnEmpty: true,
    });
    expect(JSON.stringify(reloadedComment.data)).not.toContain(title);

    const reloadedCollection = await Collection.findByPk(collection.id, {
      rejectOnEmpty: true,
    });
    expect(JSON.stringify(reloadedCollection.content)).not.toContain(title);
    expect(reloadedCollection.description).not.toContain(title);
  });

  it("should remove titles from documents that only have markdown text", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      userId: user.id,
      teamId: user.teamId,
    });
    await writeRaw("documents", document.id, {
      content: null,
      state: null,
      text: `See @[${title}](${href})`,
    });

    await script();

    const cleaned = await Document.unscoped().findByPk(document.id, {
      attributes: ["id", "text"],
      rejectOnEmpty: true,
    });
    expect(cleaned.text).not.toContain(title);
    expect(cleaned.text).toContain(href);
  });

  it("should remove titles from markdown text that lost the url of a mention", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      userId: user.id,
      teamId: user.teamId,
    });
    // Markdown staying within Outline did not carry the url before.
    await writeRaw("documents", document.id, {
      content: null,
      state: null,
      text: `See @[${title}](mention://0c440212-8b40-49fa-8a64-2548d6b60d59/issue/c85a0d80-3a89-4b25-a0cd-e7fc83f0d226)`,
    });

    await script();

    const cleaned = await Document.unscoped().findByPk(document.id, {
      attributes: ["id", "text"],
      rejectOnEmpty: true,
    });
    expect(cleaned.text).not.toContain(title);
    expect(cleaned.text).toContain("/issue/");
  });

  it("should remove legacy tokens from GitLab workspace integrations", async () => {
    const user = await buildUser();
    const authentication = await IntegrationAuthentication.create({
      service: IntegrationService.GitLab,
      userId: user.id,
      teamId: user.teamId,
      clientId: "client-id",
      clientSecret: "client-secret",
      token: "legacy-token",
      refreshToken: "legacy-refresh-token",
    });
    const integration = await Integration.create({
      service: IntegrationService.GitLab,
      type: IntegrationType.Embed,
      userId: user.id,
      teamId: user.teamId,
      authenticationId: authentication.id,
      settings: {
        gitlab: {
          url: "https://gitlab.example.com",
          installation: { id: 1, account: { id: 1, name: "a", avatarUrl: "" } },
        },
      },
    });

    await script();

    await authentication.reload();
    await integration.reload();
    expect(authentication.token).toBeFalsy();
    expect(authentication.refreshToken).toBeFalsy();
    expect(authentication.clientSecret).toEqual("client-secret");
    expect(integration.settings).toEqual({
      gitlab: { url: "https://gitlab.example.com" },
    });
  });

  it("should keep a single GitLab workspace integration per instance", async () => {
    const user = await buildUser();
    const other = await buildUser();

    /**
     * Creates a GitLab workspace integration.
     *
     * @param teamUser the user whose team the integration belongs to.
     * @param gitlab the GitLab settings.
     * @param clientId the client id of the OAuth application, if any.
     * @returns the integration.
     */
    const create = async (
      teamUser: typeof user,
      gitlab: { url?: string; pending?: boolean },
      clientId?: string
    ) => {
      const authentication = clientId
        ? await IntegrationAuthentication.create({
            service: IntegrationService.GitLab,
            userId: teamUser.id,
            teamId: teamUser.teamId,
            clientId,
            clientSecret: "secret",
          })
        : undefined;
      return Integration.create({
        service: IntegrationService.GitLab,
        type: IntegrationType.Embed,
        userId: teamUser.id,
        teamId: teamUser.teamId,
        authenticationId: authentication?.id,
        settings: { gitlab },
      });
    };

    // Connected several times with the cloud instance by a previous version.
    const cloudA = await create(user, {});
    const cloudB = await create(user, {});
    // A self-managed instance, where only one has an OAuth application.
    const selfManagedA = await create(user, {
      url: "https://gitlab.example.com/",
    });
    const selfManagedB = await create(
      user,
      { url: "https://gitlab.example.com" },
      "client-id"
    );
    // The same instance in another team is kept.
    const otherTeam = await create(other, {});

    const stats = await script();
    // Other tests may leave duplicates of their own in the shared database.
    expect(stats.duplicateGitLabIntegrations).toBeGreaterThanOrEqual(2);

    const remaining = await Integration.findAll({
      where: {
        service: IntegrationService.GitLab,
        teamId: [user.teamId, other.teamId],
      },
      paranoid: false,
    });
    const remainingIds = remaining.map((integration) => integration.id);
    expect(remainingIds).toHaveLength(3);
    // Either cloud integration may be kept, as they are created in the same
    // instant.
    expect(
      [cloudA.id, cloudB.id].filter((id) => remainingIds.includes(id))
    ).toHaveLength(1);
    expect(remainingIds).toContain(selfManagedB.id);
    expect(remainingIds).not.toContain(selfManagedA.id);
    expect(remainingIds).toContain(otherTeam.id);
  });

  it("should move accounts linked through a removed GitLab integration", async () => {
    const user = await buildUser();
    const url = "https://gitlab.example.com";

    /**
     * Creates a GitLab workspace integration of the self-managed instance.
     *
     * @param clientId the client id of the OAuth application.
     * @param createdAt when the integration was created.
     * @returns the integration.
     */
    const createWorkspace = async (clientId: string, createdAt: Date) => {
      const authentication = await IntegrationAuthentication.create({
        service: IntegrationService.GitLab,
        userId: user.id,
        teamId: user.teamId,
        clientId,
        clientSecret: "secret",
      });
      const integration = await Integration.create({
        service: IntegrationService.GitLab,
        type: IntegrationType.Embed,
        userId: user.id,
        teamId: user.teamId,
        authenticationId: authentication.id,
        settings: { gitlab: { url } },
      });
      await writeRaw("integrations", integration.id, { createdAt });
      return integration;
    };

    /**
     * Links a GitLab account through a workspace integration.
     *
     * @param integrationId the workspace integration linked through.
     * @returns the linked account integration.
     */
    const createLinkedAccount = async (integrationId: string) => {
      const owner = await buildUser({ teamId: user.teamId });
      const authentication = await IntegrationAuthentication.create({
        service: IntegrationService.GitLab,
        userId: owner.id,
        teamId: owner.teamId,
        token: "token",
      });
      return Integration.create<Integration<IntegrationType.LinkedAccount>>({
        service: IntegrationService.GitLab,
        type: IntegrationType.LinkedAccount,
        userId: owner.id,
        teamId: owner.teamId,
        authenticationId: authentication.id,
        settings: {
          gitlab: {
            url,
            integrationId,
            account: { id: 1, name: "a", avatarUrl: "" },
          },
        },
      });
    };

    // The oldest is kept, the others were connected again by a previous
    // version, one of them with another OAuth application.
    const kept = await createWorkspace("client-a", new Date("2020-01-01"));
    const sameApplication = await createWorkspace(
      "client-a",
      new Date("2020-01-02")
    );
    const otherApplication = await createWorkspace(
      "client-b",
      new Date("2020-01-03")
    );
    const keptAccount = await createLinkedAccount(kept.id);
    const movedAccount = await createLinkedAccount(sameApplication.id);
    const removedAccount = await createLinkedAccount(otherApplication.id);

    await script();

    expect(await Integration.findByPk(kept.id)).not.toBe(null);
    expect(await Integration.findByPk(sameApplication.id)).toBe(null);
    expect(await Integration.findByPk(otherApplication.id)).toBe(null);

    await keptAccount.reload();
    expect(keptAccount.settings.gitlab?.integrationId).toEqual(kept.id);
    await movedAccount.reload();
    expect(movedAccount.settings.gitlab?.integrationId).toEqual(kept.id);
    expect(
      await Integration.findByPk(removedAccount.id, { paranoid: false })
    ).toBe(null);
    expect(
      await IntegrationAuthentication.findByPk(removedAccount.authenticationId)
    ).toBe(null);
  });
});
