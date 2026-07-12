import http from "node:http";
import net from "node:net";

const listenHost = process.env.MOOSE_PROXY_PREFIX_LISTEN_HOST ?? "127.0.0.1";
const listenPort = Number(process.env.MOOSE_PROXY_PREFIX_LISTEN_PORT ?? "39081");
const targetHost = process.env.MOOSE_PROXY_PREFIX_TARGET_HOST ?? "127.0.0.1";
const targetPort = Number(process.env.MOOSE_PROXY_PREFIX_TARGET_PORT ?? "39080");
const prefix = (process.env.MOOSE_PROXY_PREFIX_PATH ?? "/prefix").replace(/\/+$/, "");

function stripPrefix(url: string): string {
  if (url === prefix) {
    return "/";
  }
  if (!url.startsWith(`${prefix}/`) && !url.startsWith(`${prefix}?`)) {
    throw new Error(`request is outside configured test prefix ${prefix}`);
  }
  return url.slice(prefix.length) || "/";
}

const server = http.createServer((request, response) => {
  let upstreamPath: string;
  try {
    upstreamPath = stripPrefix(request.url ?? "/");
  } catch (error) {
    response.writeHead(404);
    response.end(error instanceof Error ? error.message : "not found");
    return;
  }
  const upstream = http.request(
    {
      host: targetHost,
      port: targetPort,
      method: request.method,
      path: upstreamPath,
      headers: request.headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => response.destroy(error));
  request.pipe(upstream);
});

server.on("upgrade", (request, socket, head) => {
  let upstreamPath: string;
  try {
    upstreamPath = stripPrefix(request.url ?? "/");
  } catch {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  const upstream = net.connect(targetPort, targetHost, () => {
    upstream.write(`${request.method ?? "GET"} ${upstreamPath} HTTP/${request.httpVersion}\r\n`);
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      upstream.write(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}\r\n`);
    }
    upstream.write("\r\n");
    if (head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write(`prefix proxy listening at http://${listenHost}:${listenPort}${prefix}/\n`);
});

const stop = () => server.close(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
