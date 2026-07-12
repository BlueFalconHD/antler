import { Agent, fetch, type Dispatcher, type Response } from "undici";
import { CookieJar } from "tough-cookie";

export interface CodeServerSessionOptions {
  readonly baseUrl: URL;
  readonly password: string;
  readonly rejectUnauthorized: boolean;
}

export interface CodeServerSession {
  readonly baseUrl: URL;
  readonly cookieJar: CookieJar;
  cookieHeader(url?: URL): Promise<string>;
  probeVersion(): Promise<string>;
  close(): Promise<void>;
}

const redirects = new Set([301, 302, 303, 307, 308]);

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function hiddenBase(html: string): string {
  const match = /<input\b[^>]*\bname=["']base["'][^>]*\bvalue=["']([^"']*)["'][^>]*>/i.exec(html);
  return match?.[1] ? decodeHtmlAttribute(match[1]) : ".";
}

async function storeResponseCookies(jar: CookieJar, response: Response, url: URL): Promise<void> {
  for (const cookie of response.headers.getSetCookie()) {
    await jar.setCookie(cookie, url.toString());
  }
}

async function request(
  jar: CookieJar,
  dispatcher: Dispatcher,
  url: URL,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const cookie = await jar.getCookieString(url.toString());
  const headers = { ...init.headers, ...(cookie ? { cookie } : {}) };
  const response = await fetch(url, {
    dispatcher,
    redirect: "manual",
    headers,
    ...(init.method ? { method: init.method } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  await storeResponseCookies(jar, response, url);
  return response;
}

async function follow(
  jar: CookieJar,
  dispatcher: Dispatcher,
  initialUrl: URL,
): Promise<{ response: Response; url: URL }> {
  let url = initialUrl;
  for (let count = 0; count < 10; count += 1) {
    const response = await request(jar, dispatcher, url);
    if (!redirects.has(response.status)) {
      return { response, url };
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`code-server returned redirect ${response.status} without Location`);
    }
    await response.body?.cancel();
    url = new URL(location, url);
  }
  throw new Error("code-server authentication exceeded redirect limit");
}

class InMemoryCodeServerSession implements CodeServerSession {
  public constructor(
    public readonly baseUrl: URL,
    public readonly cookieJar: CookieJar,
    private readonly dispatcher: Dispatcher,
  ) {}

  public cookieHeader(url: URL = this.baseUrl): Promise<string> {
    return this.cookieJar.getCookieString(url.toString());
  }

  public async probeVersion(): Promise<string> {
    const versionUrl = new URL("version", this.baseUrl);
    const response = await request(this.cookieJar, this.dispatcher, versionUrl);
    if (!response.ok) {
      throw new Error(`code-server version probe failed with HTTP ${response.status}`);
    }
    return (await response.text()).trim();
  }

  public async close(): Promise<void> {
    await closeDispatcher(this.dispatcher);
  }
}

export async function closeDispatcher(dispatcher: Dispatcher): Promise<void> {
  const lifecycle = dispatcher as unknown as {
    close?: () => Promise<void> | void;
    destroy?: () => Promise<void> | void;
  };
  if (typeof lifecycle.close === "function") {
    await lifecycle.close.call(dispatcher);
  } else if (typeof lifecycle.destroy === "function") {
    await lifecycle.destroy.call(dispatcher);
  }
  // Bun's Undici-compatible Agent is a resource-free dispatcher marker and
  // exposes neither method. In that runtime there is nothing explicit to close.
}

export async function authenticateCodeServer(options: CodeServerSessionOptions): Promise<CodeServerSession> {
  const dispatcher = new Agent({ connect: { rejectUnauthorized: options.rejectUnauthorized } });
  const jar = new CookieJar();
  const landing = await follow(jar, dispatcher, options.baseUrl);
  const landingHtml = await landing.response.text();
  if (!landing.url.pathname.replace(/\/+$/, "").endsWith("/login")) {
    throw new Error("code-server did not present its password login flow at the configured URL");
  }

  const body = new URLSearchParams({
    password: options.password,
    base: hiddenBase(landingHtml),
    href: landing.url.toString(),
  }).toString();
  const response = await request(jar, dispatcher, landing.url, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  if (!redirects.has(response.status)) {
    await response.body?.cancel();
    throw new Error("code-server login failed; verify the URL and password");
  }
  await response.body?.cancel();

  const cookies = await jar.getCookies(options.baseUrl.toString());
  if (!cookies.some((cookie) => cookie.key === "code-server-session")) {
    throw new Error("code-server login did not issue a session cookie");
  }

  const verified = await follow(jar, dispatcher, options.baseUrl);
  await verified.response.body?.cancel();
  if (verified.url.pathname.replace(/\/+$/, "").endsWith("/login")) {
    throw new Error("code-server rejected the newly issued session cookie");
  }
  return new InMemoryCodeServerSession(options.baseUrl, jar, dispatcher);
}
