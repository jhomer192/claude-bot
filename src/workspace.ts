import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const exec = promisify(execFile);

const SLUG_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.includes("..");
}

export function repoPath(workspaceDir: string, slug: string): string {
  if (!isValidSlug(slug)) throw new Error(`Invalid repo slug: ${slug}`);
  return join(workspaceDir, slug);
}

export async function ensureCloned(
  workspaceDir: string,
  slug: string,
  githubToken: string,
): Promise<string> {
  const dest = repoPath(workspaceDir, slug);
  if (existsSync(join(dest, ".git"))) return dest;

  mkdirSync(workspaceDir, { recursive: true });
  const url = `https://x-access-token:${githubToken}@github.com/${slug}.git`;
  await exec("git", ["clone", "--depth", "50", url, dest], { maxBuffer: 32 * 1024 * 1024 });
  return dest;
}
