from __future__ import annotations

import json
from dataclasses import dataclass

from openai import OpenAI

from .config import Config


# Local reasoning models (Gemma 4, Qwen 3.x, etc.) emit chain-of-thought into a
# separate `reasoning_content` field before the actual answer. The caller's
# max_tokens caps total generation, so a small budget gets eaten by reasoning
# and produces empty content with finish_reason="length". We add a fixed budget
# on top of the caller's requested content size to absorb that.
REASONING_OVERHEAD_TOKENS = 1500


@dataclass
class LLMResult:
    text: str
    model: str


class LLMClient:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.client = OpenAI(base_url=cfg.llm_base_url, api_key=cfg.llm_api_key)

    def chat(
        self,
        system: str,
        user: str,
        *,
        temperature: float = 0.4,
        max_tokens: int = 600,
    ) -> LLMResult:
        resp = self.client.chat.completions.create(
            model=self.cfg.llm_model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=temperature,
            max_tokens=max_tokens + REASONING_OVERHEAD_TOKENS,
        )
        msg = resp.choices[0].message
        text = (msg.content or "").strip()
        if not text:
            # Reasoning model ran out of budget before emitting content. Surface
            # something useful for debugging instead of returning silently.
            finish = resp.choices[0].finish_reason
            reasoning = getattr(msg, "reasoning_content", "") or ""
            raise RuntimeError(
                f"LLM returned empty content (finish_reason={finish}). "
                f"Reasoning length: {len(reasoning)} chars. "
                "If finish_reason is 'length', raise max_tokens; if 'stop', the "
                "model genuinely refused to answer."
            )
        return LLMResult(text=text, model=self.cfg.llm_model)

    def chat_json(
        self,
        system: str,
        user: str,
        *,
        temperature: float = 0.2,
        max_tokens: int = 600,
    ) -> dict:
        """Ask for a JSON response. Tolerant of fenced blocks."""
        result = self.chat(
            system=system + "\n\nRespond with valid JSON only. No prose, no fences.",
            user=user,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        text = result.text.strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:].lstrip("\n")
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1:
            raise ValueError(f"LLM did not return JSON: {result.text!r}")
        return json.loads(text[start : end + 1])
