import { Router, type RequestHandler, type CookieOptions } from "express";
import { parse } from "cookie";
import { SignJWT, jwtVerify } from "jose";
import type { Pool } from "pg";
import { HttpError } from "./errors.js";
import {
  dummyPasswordHash,
  hashPassword,
  verifyPassword,
} from "./passwords.js";

export const sessionCookieName = "forms_session";
export const tokenIssuer = "forms-api";
export const tokenAudience = "forms-web";
export const sessionSeconds = 3600;
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthConfig {
  secret: Uint8Array;
  webOrigin: string;
  secureCookies: boolean;
}
export interface AuthenticatedUser {
  id: string;
  email: string;
}

declare module "express-serve-static-core" {
  interface Locals {
    user: AuthenticatedUser;
  }
}

export function readAuthConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  if (
    !environment.JWT_SECRET ||
    Buffer.byteLength(environment.JWT_SECRET) < 32
  ) {
    throw new Error("Set JWT_SECRET to a random secret of at least 32 bytes.");
  }
  const webOrigin = environment.WEB_ORIGIN ?? "http://localhost:3000";
  const url = new URL(webOrigin);
  const secureCookies = environment.NODE_ENV === "production";
  if (
    url.origin !== webOrigin ||
    !["http:", "https:"].includes(url.protocol) ||
    (secureCookies && url.protocol !== "https:")
  ) {
    throw new Error(
      "WEB_ORIGIN must be an exact HTTP origin (HTTPS in production).",
    );
  }
  return {
    secret: new TextEncoder().encode(environment.JWT_SECRET),
    webOrigin,
    secureCookies,
  };
}

export function requireTrustedOrigin(config: AuthConfig): RequestHandler {
  return (request, _response, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      request.get("origin") !== config.webOrigin
    ) {
      next(
        new HttpError(
          403,
          "UNTRUSTED_ORIGIN",
          "This request must come from the forms website.",
        ),
      );
      return;
    }
    next();
  };
}

function cookieOptions(config: AuthConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
  };
}

export async function issueToken(
  userId: string,
  config: AuthConfig,
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(tokenIssuer)
    .setAudience(tokenAudience)
    .setIssuedAt()
    .setExpirationTime(`${sessionSeconds}s`)
    .sign(config.secret);
}

export function authenticate(pool: Pool, config: AuthConfig): RequestHandler {
  return async (request, response, next) => {
    const token = parse(request.headers.cookie ?? "")[sessionCookieName];
    let userId: string;
    try {
      if (!token) throw new Error("Missing session");
      const { payload } = await jwtVerify(token, config.secret, {
        algorithms: ["HS256"],
        issuer: tokenIssuer,
        audience: tokenAudience,
        requiredClaims: ["sub", "exp", "iat"],
        maxTokenAge: `${sessionSeconds}s`,
        typ: "JWT",
      });
      if (!payload.sub || !uuidPattern.test(payload.sub))
        throw new Error("Invalid subject");
      userId = payload.sub;
    } catch {
      throw new HttpError(
        401,
        "UNAUTHENTICATED",
        "Please sign in to continue.",
      );
    }
    const result = await pool.query<AuthenticatedUser>(
      "SELECT id,email FROM users WHERE id=$1",
      [userId],
    );
    const user = result.rows[0];
    if (!user)
      throw new HttpError(
        401,
        "UNAUTHENTICATED",
        "Please sign in to continue.",
      );
    response.locals.user = user;
    next();
  };
}

function credentials(input: unknown): { email: string; password: string } {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !("email" in input) ||
    typeof input.email !== "string" ||
    !("password" in input) ||
    typeof input.password !== "string"
  ) {
    throw new HttpError(
      400,
      "INVALID_CREDENTIALS_INPUT",
      "Enter an email address and password.",
    );
  }
  const email = input.email.trim().toLowerCase();
  if (
    /\p{Cc}/u.test(input.email) ||
    /[\uD800-\uDFFF]/u.test(input.email) ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new HttpError(400, "INVALID_EMAIL", "Enter a valid email address.");
  }
  if (
    input.password.length < 12 ||
    input.password.length > 128 ||
    !input.password.trim()
  ) {
    throw new HttpError(
      400,
      "INVALID_PASSWORD",
      "Use a password between 12 and 128 characters.",
    );
  }
  return { email, password: input.password };
}

export function createAuthRouter(pool: Pool, config: AuthConfig): Router {
  const router = Router();
  const jsonOnly: RequestHandler = (request, _response, next) => {
    if (!request.is("application/json"))
      throw new HttpError(415, "JSON_REQUIRED", "Send application/json.");
    next();
  };
  router.post("/register", jsonOnly, async (request, response) => {
    const { email, password } = credentials(request.body);
    // Hash outside a transaction and before acquiring a database client.
    const passwordHash = await hashPassword(password);
    const result = await pool.query<AuthenticatedUser>(
      "INSERT INTO users (email,password_hash) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING RETURNING id,email",
      [email, passwordHash],
    );
    const user = result.rows[0];
    if (!user)
      throw new HttpError(
        409,
        "EMAIL_IN_USE",
        "An account already uses this email address.",
      );
    response.cookie(sessionCookieName, await issueToken(user.id, config), {
      ...cookieOptions(config),
      maxAge: sessionSeconds * 1000,
    });
    response.status(201).json({ user });
  });
  router.post("/login", jsonOnly, async (request, response) => {
    const { email, password } = credentials(request.body);
    const result = await pool.query<
      AuthenticatedUser & { password_hash: string }
    >("SELECT id,email,password_hash FROM users WHERE email=$1", [email]);
    const user = result.rows[0];
    const valid = await verifyPassword(
      password,
      user?.password_hash ?? dummyPasswordHash,
    );
    if (!user || !valid)
      throw new HttpError(
        401,
        "INVALID_LOGIN",
        "Email or password is incorrect.",
      );
    response.cookie(sessionCookieName, await issueToken(user.id, config), {
      ...cookieOptions(config),
      maxAge: sessionSeconds * 1000,
    });
    response.json({ user: { id: user.id, email: user.email } });
  });
  router.post("/logout", (_request, response) => {
    response.clearCookie(sessionCookieName, cookieOptions(config));
    response.status(204).end();
  });
  router.get("/me", authenticate(pool, config), (_request, response) => {
    response.json({ user: response.locals.user });
  });
  return router;
}
