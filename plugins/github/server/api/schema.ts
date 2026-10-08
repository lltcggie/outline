import { isEmpty, isUndefined } from "es-toolkit/compat";
import { z } from "zod";
import { BaseSchema } from "@server/routes/api/schema";

export enum SetupAction {
  install = "install",
  request = "request",
  update = "update",
}

// The callback completes both the installation of the app by an admin, which
// carries the installation, and the authorization of a member's own account,
// which carries a code only.
export const GitHubCallbackSchema = BaseSchema.extend({
  query: z
    .object({
      code: z.string().nullish(),
      state: z.string(),
      error: z.string().nullish(),
      installation_id: z.coerce.number().optional(),
      setup_action: z.enum(SetupAction).optional(),
    })
    .refine((req) => !(isEmpty(req.code) && isEmpty(req.error)), {
      error: "one of code or error is required",
    })
    .refine((req) => isEmpty(req.code) || isEmpty(req.error), {
      error: "code and error cannot both be present",
    })
    .refine(
      (req) =>
        !(
          req.setup_action === SetupAction.install &&
          isUndefined(req.installation_id)
        ),
      {
        error: "installation_id is required for installation",
      }
    ),
});

export type GitHubCallbackReq = z.infer<typeof GitHubCallbackSchema>;
