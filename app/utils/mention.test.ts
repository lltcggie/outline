import "fake-indexeddb/auto";
// The stores singleton must be imported before RootStore so that the module
// cycle through AuthStore -> developer.ts -> ~/stores resolves in the same
// order as the application entry point.
import "~/stores";
import {
  IntegrationService,
  IntegrationType,
  MentionType,
} from "@shared/types";
import Integration from "~/models/Integration";
import RootStore from "~/stores/RootStore";
import { getMentionTypeForURL } from "./mention";
import { Hook, PluginManager } from "./PluginManager";

describe("getMentionTypeForURL", () => {
  it("uses the type a workspace integration recognizes", () => {
    const store = new RootStore();
    const github = new Integration(
      {
        id: "github",
        service: IntegrationService.GitHub,
        type: IntegrationType.Embed,
        settings: {},
      },
      store.integrations
    );

    expect(
      getMentionTypeForURL({
        url: new URL("https://github.com/outline/outline/pull/1"),
        integrations: [github],
      })
    ).toEqual(MentionType.PullRequest);
  });

  it("falls back to a plain URL mention without providers", () => {
    expect(
      getMentionTypeForURL({
        url: new URL("https://example.com/some/page"),
        integrations: [],
      })
    ).toEqual(MentionType.URL);
  });

  describe("with a plugin mention provider", () => {
    beforeAll(() => {
      PluginManager.add({
        id: "test-mention-provider",
        name: "Test mention provider",
        type: Hook.MentionProvider,
        value: (url: URL) =>
          url.hostname === "tasks.example.com" ? MentionType.Issue : undefined,
      });
    });

    it("uses the type the provider recognizes", () => {
      expect(
        getMentionTypeForURL({
          url: new URL("https://tasks.example.com/task/1"),
          integrations: [],
        })
      ).toEqual(MentionType.Issue);
    });

    it("falls back to a plain URL mention for other URLs", () => {
      expect(
        getMentionTypeForURL({
          url: new URL("https://example.com/some/page"),
          integrations: [],
        })
      ).toEqual(MentionType.URL);
    });
  });
});
