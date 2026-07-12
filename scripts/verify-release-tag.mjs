import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (!packageJson || typeof packageJson.version !== "string") {
  throw new Error("package.json does not contain a valid version");
}

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag) {
  throw new Error("A release tag is required");
}

const expected = `v${packageJson.version}`;
if (tag !== expected) {
  throw new Error(`Release tag ${tag} does not match package version ${expected}`);
}

const beetProject = await readFile(
  new URL("../integrations/beet-antler/pyproject.toml", import.meta.url),
  "utf8",
);
const beetVersion = beetProject.match(/^version = "([^"]+)"$/m)?.[1];
if (beetVersion !== packageJson.version) {
  throw new Error(
    `beet-antler version ${beetVersion ?? "(missing)"} does not match package version ${packageJson.version}`,
  );
}

process.stdout.write(`Release tag ${tag} matches Antler and beet-antler package versions\n`);
