import { IntegrationType } from "@shared/types";
import { Integration, User, Team } from "@server/models";
import { allow } from "./cancan";
import {
  and,
  isOwner,
  isTeamAdmin,
  isTeamModel,
  isTeamMutable,
  or,
} from "./utils";

allow(User, "createIntegration", Team, (actor, team) =>
  and(isTeamAdmin(actor, team), isTeamMutable(actor))
);

// Linked accounts belong to a single user and reveal details of their account
// in the external service, so only that user can read them.
allow(User, "read", Integration, (actor, integration) =>
  and(
    isTeamModel(actor, integration),
    integration?.type !== IntegrationType.LinkedAccount ||
      isOwner(actor, integration)
  )
);

// Linked accounts hold the user's own token, which is sent to the instance in
// their settings, so only that user can change them.
allow(User, "update", Integration, (actor, integration) =>
  and(
    isTeamModel(actor, integration),
    isTeamMutable(actor),
    integration?.type === IntegrationType.LinkedAccount
      ? isOwner(actor, integration)
      : actor.isAdmin
  )
);

allow(User, "delete", Integration, (actor, integration) =>
  and(
    isTeamModel(actor, integration),
    isTeamMutable(actor),
    or(
      actor.isAdmin,
      // Any member can disconnect their own linked account.
      isOwner(actor, integration) &&
        integration.type === IntegrationType.LinkedAccount
    )
  )
);
