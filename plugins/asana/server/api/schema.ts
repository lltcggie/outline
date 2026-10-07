import { isEmpty } from "es-toolkit/compat";
import { z } from "zod";
import { BaseSchema } from "@server/routes/api/schema";

/** The query of the OAuth callback, Asana sends either a code or an error. */
export const AsanaCallbackSchema = BaseSchema.extend({
  query: z
    .object({
      code: z.string().nullish(),
      state: z.string(),
      error: z.string().nullish(),
    })
    .refine((req) => !(isEmpty(req.code) && isEmpty(req.error)), {
      error: "one of code or error is required",
    })
    .refine((req) => isEmpty(req.code) || isEmpty(req.error), {
      error: "code and error cannot both be present",
    }),
});

export type AsanaCallbackReq = z.infer<typeof AsanaCallbackSchema>;
