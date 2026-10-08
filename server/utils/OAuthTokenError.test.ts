import {
  OAuthTokenError,
  parseJsonBody,
  parseOAuthTokenError,
} from "./OAuthTokenError";

describe("parseJsonBody", () => {
  it("should parse a JSON body", () => {
    expect(parseJsonBody('{"access_token":"t"}')).toEqual({
      access_token: "t",
    });
  });

  it("should return undefined for a body that is not JSON", () => {
    expect(parseJsonBody("<html>Bad Gateway</html>")).toBeUndefined();
    expect(parseJsonBody("")).toBeUndefined();
  });
});

describe("parseOAuthTokenError", () => {
  it("should read an OAuth error from the text of a response", () => {
    const error = parseOAuthTokenError(
      "Service",
      JSON.stringify({
        error: "invalid_grant",
        error_description: "The refresh token was revoked",
      })
    );

    expect(error).toBeInstanceOf(OAuthTokenError);
    expect(error?.code).toEqual("invalid_grant");
    expect(error?.message).toEqual(
      "Service refused the token request: invalid_grant (The refresh token was revoked)"
    );
  });

  it("should read an OAuth error from a parsed response without a description", () => {
    const error = parseOAuthTokenError("Service", { error: "invalid_client" });

    expect(error?.code).toEqual("invalid_client");
    expect(error?.message).toEqual(
      "Service refused the token request: invalid_client"
    );
  });

  it("should ignore a body that is not JSON", () => {
    expect(parseOAuthTokenError("Service", "Bad Gateway")).toBeUndefined();
  });

  it("should ignore JSON that is not an OAuth error", () => {
    expect(
      parseOAuthTokenError("Service", JSON.stringify({ message: "Not found" }))
    ).toBeUndefined();
    expect(
      parseOAuthTokenError("Service", { access_token: "t" })
    ).toBeUndefined();
  });
});
