import {
  accessTokenAudience,
  completeAuthorization,
  exchangeToken,
  issueApprovalProof,
  hmacSecret,
  isPublicHost,
  metadata,
  parseConnectorResource,
  protectedResource,
  registerClient,
  startAuthorization,
} from "./_oauth.js";

export const LINK_STATUS_TEXT =
  "The wallet link is handled by the local grokwallet CLI. This connector has no wallet access. After approval it can be removed.";

const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
};

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function text(status, message) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function originOf(url, allowLocal) {
  if (isPublicHost(url.hostname)) return url.origin;
  if (!allowLocal) return "";
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") return url.origin;
  return "";
}

function resourceMetadataUrl(origin, canonical) {
  const resource = new URL(canonical);
  if (resource.pathname === "/mcp") {
    return `${origin}/.well-known/oauth-protected-resource/mcp?code=${encodeURIComponent(resource.searchParams.get("code") || "")}`;
  }
  return `${origin}/.well-known/oauth-protected-resource${resource.pathname}`;
}

function unauthorized(origin, canonical) {
  const metadataUrl = resourceMetadataUrl(origin, canonical);
  return json(
    401,
    { error: "invalid_token" },
    { "www-authenticate": `Bearer realm="grokwallet", resource_metadata="${metadataUrl}"` },
  );
}

async function readBody(request, limit) {
  const textBody = await request.text();
  if (textBody.length > limit) return null;
  return textBody;
}

function pathName(url) {
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) return url.pathname.replace(/\/+$/, "");
  return url.pathname;
}

function rpc(id, result) {
  return json(200, { jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message) {
  return json(400, { jsonrpc: "2.0", id, error: { code, message } });
}

async function bearerAudience(request, secret, now) {
  if (new URL(request.url).searchParams.has("access_token")) return "";
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._~-]{20,4096})$/.exec(header);
  if (!match) return "";
  return accessTokenAudience(match[1], secret, now);
}

async function handleMcp(request, url, env, now, canonical) {
  const origin = url.origin;
  const secret = hmacSecret(env);
  if (request.method === "POST") {
    const audience = secret ? await bearerAudience(request, secret, now) : "";
    if (!audience || audience !== canonical) return unauthorized(origin, canonical);
    const raw = await readBody(request, 16384);
    if (raw === null) return rpcError(null, -32700, "request body is too large");
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return rpcError(null, -32700, "request body is not JSON");
    }
    if (Array.isArray(message) || !message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(null, -32600, "invalid JSON-RPC request");
    }
    const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : undefined;
    if (message.method === "notifications/initialized" && id === undefined) return new Response(null, { status: 202 });
    if (id === undefined) return new Response(null, { status: 202 });
    if (message.method === "initialize") {
      const requested = message.params && typeof message.params.protocolVersion === "string" ? message.params.protocolVersion : "";
      const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : "2025-06-18";
      return rpc(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "grokwallet-link", version: "0.2.3" },
        instructions:
          "This connector only opens the approval page. Wallet actions stay on the local grokwallet CLI. This server does not receive wallet credentials.",
      });
    }
    if (message.method === "ping") return rpc(id, {});
    if (message.method === "tools/list") {
      return rpc(id, {
        tools: [
          {
            name: "link_status",
            description: "Says that the wallet link is handled by the local grokwallet CLI. This server holds no wallet access.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      });
    }
    if (message.method === "tools/call") {
      const name = message.params && message.params.name;
      const args = message.params && message.params.arguments ? message.params.arguments : {};
      if (name !== "link_status" || typeof args !== "object" || Array.isArray(args)) {
        return rpcError(id, -32602, "unknown tool");
      }
      if (Object.keys(args).length > 0) {
        return rpc(id, { content: [{ type: "text", text: "link_status takes no arguments." }], isError: true });
      }
      return rpc(id, { content: [{ type: "text", text: LINK_STATUS_TEXT }], isError: false });
    }
    return rpcError(id, -32601, "method not found");
  }
  if (request.method === "GET" || request.method === "DELETE") {
    const audience = secret ? await bearerAudience(request, secret, now) : "";
    if (!audience || audience !== canonical) return unauthorized(origin, canonical);
    return new Response(null, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
  }
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export async function handleRequest(request, env = {}, options = {}) {
  try {
    const url = new URL(request.url);
    const origin = originOf(url, options.allowLocal === true);
    if (!origin) return text(404, "not found");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });
    const now = options.now || Math.floor(Date.now() / 1000);
    const path = pathName(url);
    const secret = hmacSecret(env);

    if (path === "/.well-known/oauth-authorization-server" || path.startsWith("/.well-known/oauth-authorization-server/")) {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
      return json(200, metadata(origin), { "cache-control": "public, max-age=300" });
    }

    if (path === "/.well-known/oauth-protected-resource") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
      return json(200, protectedResource(origin, `${origin}/mcp`), { "cache-control": "public, max-age=300" });
    }

    const protectedPath = /^\/\.well-known\/oauth-protected-resource(\/mcp(?:\/c\/[^/]+)?)$/.exec(path);
    if (protectedPath) {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
      const suffix = protectedPath[1];
      const resourceUrl = suffix === "/mcp" ? `${origin}/mcp${url.search}` : `${origin}${suffix}`;
      const resource = parseConnectorResource(resourceUrl, origin);
      if (!resource && suffix !== "/mcp") return text(404, "not found");
      const canonical = resource ? resource.canonical : `${origin}/mcp`;
      return json(200, protectedResource(origin, canonical), { "cache-control": "public, max-age=300" });
    }

    if (path === "/oauth/register") {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      if (!secret) return json(503, { error: "server_error", error_description: "GROKWALLET_OAUTH_HMAC_KEY is not configured" });
      const raw = await readBody(request, 8192);
      if (raw === null) return json(400, { error: "invalid_client_metadata" });
      const type = request.headers.get("content-type") || "";
      if (!type.includes("application/json")) return json(400, { error: "invalid_client_metadata" });
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "invalid_client_metadata" });
      }
      const result = await registerClient(body, secret, now);
      if (!result.client) return json(400, { error: result.error, error_description: result.description });
      return json(201, result.client);
    }

    if (path === "/oauth/authorize") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
      if (!secret) return text(503, "GROKWALLET_OAUTH_HMAC_KEY is not configured");
      const result = await startAuthorization(url.searchParams, origin, secret, now);
      if (result.redirect) return redirect(result.redirect);
      return text(result.status || 400, result.description || result.error || "invalid_request");
    }

    if (path === "/oauth/proof") {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      if (!secret) return json(503, { error: "server_error", error_description: "GROKWALLET_OAUTH_HMAC_KEY is not configured" });
      const type = request.headers.get("content-type") || "";
      if (!type.includes("application/json")) return json(400, { error: "invalid_request" });
      const raw = await readBody(request, 8192);
      if (raw === null) return json(400, { error: "invalid_request" });
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "invalid_request" });
      }
      const result = await issueApprovalProof(body && body.txn, body && body.user_code, secret, now);
      if (result.body) return json(result.status, result.body);
      return json(result.status, { error: result.error });
    }

    if (path === "/oauth/complete") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
      if (!secret) return text(503, "GROKWALLET_OAUTH_HMAC_KEY is not configured");
      const result = await completeAuthorization(url.searchParams, secret, now);
      if (result.redirect) return redirect(result.redirect);
      return text(result.status || 400, result.error || "invalid_request");
    }

    if (path === "/oauth/token") {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      if (!secret) return json(503, { error: "server_error", error_description: "GROKWALLET_OAUTH_HMAC_KEY is not configured" });
      const type = request.headers.get("content-type") || "";
      if (!type.includes("application/x-www-form-urlencoded")) return json(400, { error: "invalid_request" });
      const raw = await readBody(request, 16384);
      if (raw === null) return json(400, { error: "invalid_request" });
      const result = await exchangeToken(new URLSearchParams(raw), secret, now, request.headers.get("authorization") || "");
      if (result.body) return json(200, result.body);
      return json(result.status, { error: result.error });
    }

    const connector = parseConnectorResource(url.origin + path + (path === "/mcp" ? url.search : ""), origin);
    if (connector && (path === "/mcp" || path.startsWith("/mcp/c/"))) {
      return handleMcp(request, url, env, now, connector.canonical);
    }

    return text(404, "not found");
  } catch {
    return json(500, { error: "server_error" });
  }
}
