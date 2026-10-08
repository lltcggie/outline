import { IntegrationService, IntegrationType } from "@shared/types";
import stores from "~/stores";
import { client } from "~/utils/ApiClient";

describe("IntegrationsStore", () => {
  beforeEach(() => {
    stores.integrations.clear();
    vi.mocked(client.post).mockReset();
  });

  it("should take the integrations of the service the server no longer returns out of the store", async () => {
    const kept = stores.integrations.add({
      id: "github-kept",
      service: IntegrationService.GitHub,
      type: IntegrationType.LinkedAccount,
    });
    const gone = stores.integrations.add({
      id: "github-gone",
      service: IntegrationService.GitHub,
      type: IntegrationType.Embed,
    });
    const other = stores.integrations.add({
      id: "asana",
      service: IntegrationService.Asana,
      type: IntegrationType.LinkedAccount,
    });
    vi.mocked(client.post).mockResolvedValue({
      data: [
        {
          id: kept.id,
          service: IntegrationService.GitHub,
          type: IntegrationType.LinkedAccount,
        },
      ],
      pagination: { limit: 25, offset: 0, total: 1 },
    });

    const results = await stores.integrations.fetchService(
      IntegrationService.GitHub
    );

    expect(client.post).toHaveBeenCalledWith(
      "/integrations.list",
      expect.objectContaining({ service: IntegrationService.GitHub })
    );
    expect(results.map((integration) => integration.id)).toEqual([kept.id]);
    expect(stores.integrations.get(gone.id)).toBeUndefined();
    expect(stores.integrations.get(kept.id)).toBe(kept);
    // Other services are left alone.
    expect(stores.integrations.get(other.id)).toBe(other);
  });
});
