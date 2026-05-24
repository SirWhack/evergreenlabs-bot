// OpenRouter client. Slice 2 fills this in to replace the Python
// llm_client.py. ADR-0001 §D5: default model `anthropic/claude-haiku-4.5`,
// respect `LLM_MODEL` env var as override, drop the legacy
// REASONING_OVERHEAD_TOKENS knob.
//
// Intentionally hollow for Slice 1 — the tracer-bullet pipeline does no LLM
// work. Anything that needs the client should fail loudly until Slice 2.

export interface LlmEnv {
  OPENROUTER_API_KEY: string;
  LLM_MODEL?: string;
}

export function defaultModel(env: LlmEnv): string {
  return env.LLM_MODEL || "anthropic/claude-haiku-4.5";
}

export async function complete(_env: LlmEnv, _prompt: string): Promise<string> {
  throw new Error("llm.complete() not implemented — lands in Slice 2");
}
