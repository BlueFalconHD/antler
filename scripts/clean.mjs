import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const destination = fileURLToPath(new URL("../dist", import.meta.url));
if (path.basename(destination) !== "dist") {
  throw new Error("refusing to clean an unexpected build directory");
}
await rm(destination, { recursive: true, force: true });
