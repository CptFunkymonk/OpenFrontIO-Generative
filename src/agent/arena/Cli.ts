import fs from "fs";
import { fileURLToPath } from "url";

/**
 * True if the module at `url` (its import.meta.url) is the script node was
 * started with, so its main() runs only then and tests can import it.
 * Compares real paths: node resolves symlinks in a module's URL but not in
 * process.argv[1], so a script started through a symlinked path would
 * otherwise do nothing and exit 0.
 */
export function isMain(url: string): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return fs.realpathSync(script) === fs.realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
