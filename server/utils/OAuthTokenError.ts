import { z } from "zod";

/** A refusal of an OAuth token endpoint, with the OAuth error code. */
export class OAuthTokenError extends Error {
  constructor(
    /** The service that refused the request, for the message. */
    service: string,
    /**
     * The OAuth error code, such as "invalid_grant" when the refresh token
     * was revoked or has expired.
     */
    public code: string,
    description?: string
  ) {
    super(
      `${service} refused the token request: ${code}${description ? ` (${description})` : ""}`
    );
  }
}

/**
 * Reads the error of a token endpoint response. The body may be the parsed
 * JSON or the raw text, as a refusal is not always JSON at all, such as the
 * page of a proxy in front of the service.
 *
 * @param service the service that responded, for the message of the error.
 * @param body the response body, parsed or as text.
 * @returns the error, or undefined when the body is not an OAuth error.
 */
export function parseOAuthTokenError(
  service: string,
  body: unknown
): OAuthTokenError | undefined {
  const json = typeof body === "string" ? parseJsonBody(body) : body;
  const result = TokenErrorBodySchema.safeParse(json);
  if (!result.success) {
    return undefined;
  }
  return new OAuthTokenError(
    service,
    result.data.error,
    result.data.error_description
  );
}

/**
 * Reads the body of a token endpoint response as JSON, so that it can be
 * validated against the shape the service documents.
 *
 * @param body the response body as text.
 * @returns the parsed body, or undefined when it is not JSON at all, such as
 * the page of a proxy in front of the service.
 */
export function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

// The body of an error from an OAuth token endpoint, see RFC 6749 §5.2.
const TokenErrorBodySchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});
