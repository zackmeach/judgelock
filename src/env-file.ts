import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OPENAI_ENV_KEY = "OPENAI_API_KEY";
export const ANTHROPIC_ENV_KEY = "ANTHROPIC_API_KEY";

export const PROVIDER_ENV_KEYS = {
  openai: OPENAI_ENV_KEY,
  anthropic: ANTHROPIC_ENV_KEY,
} as const;

export type ProviderEnvName = keyof typeof PROVIDER_ENV_KEYS;

export function envFilePath(root: string): string {
  return join(root, ".env");
}

function parseEnvValue(raw: string): string {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

/** Loads .env from disk into process.env, overwriting keys defined in the file. */
export function loadEnvFile(root: string): void {
  const path = envFilePath(root);
  if (!existsSync(path)) return;

  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = parseEnvValue(trimmed.slice(eq + 1));
    process.env[key] = value;
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export function maskSecret(value: string): string {
  if (value.length <= 12) return "***";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

export interface EnvKeyStatus {
  name: string;
  set: boolean;
  length?: number;
  masked?: string;
}

export function getEnvKeyStatus(name: string): EnvKeyStatus {
  const value = process.env[name];
  if (!value) {
    return { name, set: false };
  }
  return {
    name,
    set: true,
    length: value.length,
    masked: maskSecret(value),
  };
}

export function formatEnvKeyStatus(status: EnvKeyStatus): string {
  if (!status.set) return "missing";
  return `set (${status.length} chars, ${status.masked})`;
}

export function setEnvKey(root: string, key: string, value: string): void {
  const path = envFilePath(root);
  const lines = existsSync(path)
    ? readFileSync(path, "utf8").split("\n")
    : [];

  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    const active = trimmed.startsWith("#")
      ? trimmed.slice(1).trim()
      : trimmed;
    if (active.startsWith(`${key}=`)) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }

  if (!found) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(`${key}=${value}`);
  }

  const body = lines.join("\n");
  writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  process.env[key] = value;
}

export function resolveProviderEnvKey(provider: string): string | null {
  const normalized = provider.toLowerCase();
  if (normalized in PROVIDER_ENV_KEYS) {
    return PROVIDER_ENV_KEYS[normalized as ProviderEnvName];
  }
  return null;
}
