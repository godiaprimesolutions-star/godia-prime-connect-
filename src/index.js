const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

function getSecret(env) {
  return typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length >= 32
    ? env.SESSION_SECRET : null;
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyPin(pin, salt, expectedHex) {
  if (typeof pin !== "string" || !/^\d{4,8}$/.test(pin)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 210000
  }, key, 256);
  const actual = toHex(bits);
  if (actual.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  return diff === 0;
}

async function signSession(sessionId, expiresAt, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const payload = `${sessionId}.${expiresAt}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${toHex(signature)}`;
}

async function handleApi(request, env, path) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (path === "/api/health" && request.method === "GET") {
    let database = "unavailable";
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      database = "connected";
    } catch (_) {
      database = "not_configured_or_unavailable";
    }
    return json({ ok: true, app: "GODIA PRIME CONNECT", api: "ready", database, timestamp: new Date().toISOString() });
  }

  if (path === "/api/auth/login" && request.method === "POST") {
    if (!env.DB) return json({ ok: false, error: "DATABASE_NOT_CONFIGURED", message: "The D1 database is not connected yet." }, 503);
    if (!getSecret(env)) return json({ ok: false, error: "SESSION_SECRET_NOT_CONFIGURED", message: "Configure a SESSION_SECRET of at least 32 characters before enabling login." }, 503);
    let body;
    try { body = await request.json(); } catch (_) { return json({ ok: false, error: "INVALID_JSON", message: "Send a valid JSON request." }, 400); }
    const phone = String(body.phone || "").replace(/[\s()-]/g, "");
    const pin = String(body.pin || "");
    if (!/^\+?[0-9]{8,15}$/.test(phone) || !/^\d{4,8}$/.test(pin)) {
      return json({ ok: false, error: "INVALID_CREDENTIALS", message: "Enter a valid phone number and 4–8 digit PIN." }, 400);
    }
    try {
      const user = await env.DB.prepare(
        "SELECT id, phone, display_name, role, active, pin_salt, pin_hash FROM users WHERE phone = ? LIMIT 1"
      ).bind(phone).first();
      if (!user || !user.active || !(await verifyPin(pin, user.pin_salt, user.pin_hash))) {
        return json({ ok: false, error: "INVALID_CREDENTIALS", message: "Phone number or PIN is incorrect." }, 401);
      }
      const sessionId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(sessionId, user.id, expiresAt).run();
      const token = await signSession(sessionId, expiresAt, getSecret(env));
      return json({ ok: true, token, expiresAt, user: { id: user.id, phone: user.phone, name: user.display_name, role: user.role } });
    } catch (error) {
      return json({ ok: false, error: "LOGIN_FAILED", message: "Login could not be completed. Check database setup and try again." }, 500);
    }
  }

  if (path === "/api/ai/chat" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (_) { return json({ ok: false, error: "INVALID_JSON", message: "Send a valid JSON request." }, 400); }
    const message = String(body.message || "").trim();
    if (!message) return json({ ok: false, error: "EMPTY_MESSAGE", message: "Type a message first." }, 400);
    const q = message.toLowerCase();
    let answer = "I can guide you around GODIA PRIME CONNECT. Tell me whether you need help with products, suppliers, orders, jobs, services, or account access.";
    if (/product|goods|item|stock|marketplace/.test(q)) answer = "Open Goods Marketplace to browse available listings. Only products entered by real suppliers should be treated as current stock or prices.";
    else if (/supplier|wholesale|distributor/.test(q)) answer = "Look for the supplier or business section in the app. Supplier listings and contact details must be provided by the actual business; this starter API does not create sample suppliers.";
    else if (/order|buy|purchase|delivery/.test(q)) answer = "Use the order features shown in the app. Note: order creation and synchronisation to D1 are not implemented in this starter backend yet.";
    else if (/job|work|employment/.test(q)) answer = "Open the Jobs section to view job information entered by real posters. Job posting and cloud synchronisation still need their API endpoints.";
    else if (/login|pin|password|account/.test(q)) answer = "Login checks registered users in the D1 database. No sample account is included; an administrator must securely create a real user record before login can succeed.";
    return json({ ok: true, answer, mode: "built_in_guidance", ai_provider_connected: false });
  }

  return json({ ok: false, error: "NOT_FOUND", message: "API endpoint not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url.pathname);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("GODIA PRIME CONNECT assets are not configured.", { status: 503 });
  }
};
