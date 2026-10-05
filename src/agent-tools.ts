import {
  listCorpusDocFiles,
  readCorpusDocument,
  searchCorpusDocuments,
} from "./corpus-docs.ts";

export const AGENT_TOOL_NAMES = [
  "list_documents",
  "read_document",
  "search_documents",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export interface AgentToolDefinition {
  name: AgentToolName;
  description: string;
  parameters: Record<string, unknown>;
}

export const AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: "list_documents",
    description:
      "List the Medicare enrollment documents available in the corpus.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "read_document",
    description:
      "Read the full text of one corpus document by filename (e.g. 01-when-coverage-starts.md).",
    parameters: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Corpus markdown filename under corpus/docs.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "search_documents",
    description:
      "Search corpus documents for a query string. Returns matching line snippets.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to search for (case-insensitive).",
        },
        limit: {
          type: "integer",
          description: "Maximum number of matches to return (default 5).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

function isAgentToolName(name: string): name is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(name);
}

function parseLimit(value: unknown, defaultLimit = 5): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return defaultLimit;
  }
  return Math.min(value, 20);
}

/**
 * Runs one agent tool against the local corpus. Returns JSON text for the model.
 */
export function executeAgentTool(
  root: string,
  name: string,
  args: Record<string, unknown>,
): string {
  if (!isAgentToolName(name)) {
    return JSON.stringify({ error: `unknown tool: ${name}` });
  }

  switch (name) {
    case "list_documents": {
      const files = listCorpusDocFiles(root);
      return JSON.stringify({ documents: files });
    }
    case "read_document": {
      const filename = args.filename;
      if (typeof filename !== "string" || filename.trim().length === 0) {
        return JSON.stringify({ error: "filename is required" });
      }
      try {
        const content = readCorpusDocument(root, filename.trim());
        return JSON.stringify({ filename, content });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: message });
      }
    }
    case "search_documents": {
      const query = args.query;
      if (typeof query !== "string" || query.trim().length === 0) {
        return JSON.stringify({ error: "query is required" });
      }
      const limit = parseLimit(args.limit);
      const matches = searchCorpusDocuments(root, query, limit);
      return JSON.stringify({ query, matches });
    }
    default: {
      const unexpected: never = name;
      return JSON.stringify({ error: `unhandled tool: ${unexpected}` });
    }
  }
}
