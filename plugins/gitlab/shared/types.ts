declare module "@shared/types" {
  interface EmbedIntegrationSettings {
    gitlab?: {
      url?: string;
      /**
       * Whether the instance is still being connected, set until an admin
       * has completed authorization with its OAuth application.
       */
      pending?: boolean;
      installation?: {
        id: number;
        account: { id: number; name: string; avatarUrl: string };
      };
    };
  }

  interface LinkedAccountIntegrationSettings {
    gitlab?: {
      /** The self-managed instance URL, gitlab.com when unset. */
      url?: string;
      /**
       * The workspace integration whose OAuth application issued the token,
       * unset for accounts linked by an earlier version.
       */
      integrationId?: string;
      account: { id: number; name: string; avatarUrl: string };
    };
  }
}

export {};
