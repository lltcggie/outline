declare module "@shared/types" {
  interface LinkedAccountIntegrationSettings {
    asana?: {
      account: {
        id: string;
        name: string;
        email?: string;
        avatarUrl?: string;
      };
    };
  }
}

export {};
