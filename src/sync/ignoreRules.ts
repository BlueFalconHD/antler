import { promises as fs } from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { isHardExcluded } from "./paths.js";

export class IgnoreRules {
  private constructor(private readonly matcher: Ignore) {}

  public static async load(localRoot: string, configured: readonly string[]): Promise<IgnoreRules> {
    const matcher = ignore();
    try {
      matcher.add(await fs.readFile(path.join(localRoot, ".gitignore"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    matcher.add([...configured]);
    return new IgnoreRules(matcher);
  }

  public ignores(relativePath: string, directory: boolean): boolean {
    if (isHardExcluded(relativePath)) {
      return true;
    }
    const candidate = directory ? `${relativePath}/` : relativePath;
    return this.matcher.ignores(candidate);
  }
}
