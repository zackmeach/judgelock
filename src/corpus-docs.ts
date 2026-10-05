import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeBlob } from "./identity.ts";

const CORPUS_DOCS_DIR = "corpus/docs";

/** Lists corpus doc filenames (sorted) under corpus/docs. */
export function listCorpusDocFiles(root: string): string[] {
  const docsDir = join(root, CORPUS_DOCS_DIR);
  return readdirSync(docsDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

function corpusDocPath(root: string, filename: string): string {
  return join(root, CORPUS_DOCS_DIR, filename);
}

/** Reads one corpus document by filename (must end with .md). */
export function readCorpusDocument(root: string, filename: string): string {
  if (!filename.endsWith(".md") || filename.includes("/") || filename.includes("\\")) {
    throw new Error(`invalid corpus filename: ${filename}`);
  }
  const path = corpusDocPath(root, filename);
  return normalizeBlob(readFileSync(path, "utf8"));
}

export interface CorpusSearchMatch {
  filename: string;
  line: number;
  snippet: string;
}

/**
 * Case-insensitive substring search across corpus docs. Returns line snippets
 * with a little surrounding context.
 */
export function searchCorpusDocuments(
  root: string,
  query: string,
  limit = 5,
): CorpusSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }

  const matches: CorpusSearchMatch[] = [];
  for (const filename of listCorpusDocFiles(root)) {
    const content = readCorpusDocument(root, filename);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.toLowerCase().includes(needle)) continue;
      const snippet = line.trim().slice(0, 240);
      matches.push({ filename, line: i + 1, snippet });
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

export function describeCorpusDocs(root: string): string {
  const files = listCorpusDocFiles(root);
  return `${files.length} docs in corpus/docs`;
}
