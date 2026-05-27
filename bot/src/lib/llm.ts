// OpenRouter (OpenAI-compatible) LLM client. Ports
// src/evergreenlabs_bot/llm_client.py per ADR-0001 §D5:
//   - default model `anthropic/claude-haiku-4.5`, override via LLM_MODEL env
//   - drop REASONING_OVERHEAD_TOKENS (was a Gemma/Qwen local-reasoning hack)
//   - chatJson must tolerate fenced code blocks
//
// We hit OpenRouter directly with fetch — one HTTPS request per call, no need
// to pull the openai npm package into the Worker bundle.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const INCEPTION_URL = "https://api.inceptionlabs.ai/v1/chat/completions";

export interface LlmEnv {
  OPENROUTER_API_KEY: string;
  LLM_MODEL?: string;
  DIFFUSION_KEY?: string;
}

export interface ChatOpts {
  temperature?: number;
  maxTokens?: number;
  /** Override the default model (otherwise reads env.LLM_MODEL). */
  model?: string;
}

export interface ChatResult {
  text: string;
  model: string;
  finishReason: string | null;
}

export function defaultModel(env: LlmEnv): string {
  return env.LLM_MODEL || "anthropic/claude-haiku-4.5";
}

/**
 * Single chat completion against OpenRouter. Returns the stripped text body.
 * Raises if the provider returned empty content (usually finish_reason="length"
 * on a too-small max_tokens budget).
 */
/**
 * Strip markdown code fences and surrounding quotes that models sometimes
 * wrap around output. Every pipeline needs clean text; none wants fences.
 */
export function stripFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  }
  text = text.replace(/^"+|"+$/g, "").trim();
  return text;
}

function isInceptionModel(model: string): boolean {
  return model.startsWith("mercury-");
}

function resolveProvider(env: LlmEnv, model: string): { url: string; apiKey: string; providerName: string } {
  if (isInceptionModel(model)) {
    if (!env.DIFFUSION_KEY) throw new Error("DIFFUSION_KEY not set — required for mercury models");
    return { url: INCEPTION_URL, apiKey: env.DIFFUSION_KEY, providerName: "Inception" };
  }
  return { url: OPENROUTER_URL, apiKey: env.OPENROUTER_API_KEY, providerName: "OpenRouter" };
}

export async function chat(
  env: LlmEnv,
  system: string,
  user: string,
  opts: ChatOpts = {},
): Promise<ChatResult> {
  const model = opts.model ?? defaultModel(env);
  const { url, apiKey, providerName } = resolveProvider(env, model);
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 600,
  };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (providerName === "OpenRouter") {
    headers["HTTP-Referer"] = "https://github.com/SirWhack/evergreenlabs-bot";
    headers["X-Title"] = "evergreenlabs-bot";
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`${providerName} ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string };
      finish_reason?: string | null;
    }>;
    model?: string;
  };
  const choice = data.choices?.[0];
  const rawText = (choice?.message?.content ?? "").trim();
  const finishReason = choice?.finish_reason ?? null;
  if (!rawText) {
    throw new Error(
      `LLM returned empty content (finish_reason=${finishReason}). ` +
        `If finish_reason is 'length', raise maxTokens; if 'stop', the model refused.`,
    );
  }
  return { text: stripFences(rawText), model: data.model ?? model, finishReason };
}

/**
 * Ask for a JSON object. Tolerates ```json``` fences and leading prose by
 * locating the first `{` and the last `}` and JSON.parse'ing the slice.
 * Mirrors LLMClient.chat_json in the Python source.
 */
export async function chatJson<T = Record<string, unknown>>(
  env: LlmEnv,
  system: string,
  user: string,
  opts: ChatOpts = {},
): Promise<T> {
  const result = await chat(
    env,
    system + "\n\nRespond with valid JSON only. No prose, no fences.",
    user,
    {
      ...opts,
      temperature: opts.temperature ?? 0.2,
    },
  );
  const text = result.text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`LLM did not return JSON: ${JSON.stringify(result.text)}`);
  }
  return JSON.parse(text.slice(start, end + 1)) as T;
}
