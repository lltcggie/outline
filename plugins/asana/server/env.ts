import { IsBoolean, IsNumber, IsOptional, Min } from "class-validator";
import { Minute } from "@shared/utils/time";
import { Environment } from "@server/env";
import { Public } from "@server/utils/decorators/Public";
import environment from "@server/utils/environment";
import { CannotUseWithout } from "@server/utils/validators";

class AsanaPluginEnvironment extends Environment {
  /**
   * Asana OAuth application client id. To enable integration with Asana, each
   * member links their own Asana account through this application.
   */
  @Public
  @IsOptional()
  @CannotUseWithout("ASANA_CLIENT_SECRET")
  public ASANA_CLIENT_ID = this.toOptionalString(environment.ASANA_CLIENT_ID);

  /**
   * Asana OAuth application client secret. To enable integration with Asana.
   */
  @IsOptional()
  @CannotUseWithout("ASANA_CLIENT_ID")
  public ASANA_CLIENT_SECRET = this.toOptionalString(
    environment.ASANA_CLIENT_SECRET
  );

  /**
   * The OAuth scopes requested when linking an account, space separated. An
   * application registered with granular scopes needs the defaults, one
   * registered with full permissions must use "default" instead.
   */
  @IsOptional()
  public ASANA_OAUTH_SCOPES =
    this.toOptionalString(environment.ASANA_OAUTH_SCOPES) ??
    "tasks:read projects:read users:read";

  /**
   * Whether the section a task is in is appended to its name in previews,
   * e.g. "Task name · In progress". Defaults to true.
   */
  @IsBoolean()
  public ASANA_SHOW_SECTION = this.toBoolean(
    environment.ASANA_SHOW_SECTION ?? "true"
  );

  /**
   * How long the details of a task or project are cached for each user, in
   * seconds. Every cached link costs one Asana API call per period and user,
   * so raise this when Asana's rate limit is hit. Defaults to 5 minutes. The
   * cache cannot be disabled, a value of 0 would fall back to the default
   * expiry of the cache helper, which is a day.
   */
  @IsNumber()
  @Min(1)
  @IsOptional()
  public ASANA_CACHE_SECONDS =
    this.toOptionalNumber(environment.ASANA_CACHE_SECONDS) ??
    5 * Minute.seconds;
}

export default new AsanaPluginEnvironment();
