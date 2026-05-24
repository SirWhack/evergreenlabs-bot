"""GitHub Projects v2 GraphQL client.

Projects v2 has no REST coverage — must use GraphQL. We pull a single
user-scoped project by number, normalize the items + their custom-field values,
and return a flat list.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime

import httpx

from .config import Config
from .github_client import GitHubError


GRAPHQL = "https://api.github.com/graphql"


QUERY = """
query($login: String!, $number: Int!) {
  user(login: $login) {
    projectV2(number: $number) {
      id
      title
      number
      url
      items(first: 100) {
        nodes {
          id
          updatedAt
          type
          content {
            __typename
            ... on Issue {
              number
              title
              body
              url
              state
              repository { nameWithOwner }
            }
            ... on PullRequest {
              number
              title
              body
              url
              state
              repository { nameWithOwner }
            }
            ... on DraftIssue {
              title
              body
            }
          }
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
              ... on ProjectV2ItemFieldTextValue {
                text
                field { ... on ProjectV2Field { name } }
              }
              ... on ProjectV2ItemFieldNumberValue {
                number
                field { ... on ProjectV2Field { name } }
              }
              ... on ProjectV2ItemFieldDateValue {
                date
                field { ... on ProjectV2Field { name } }
              }
            }
          }
        }
      }
    }
  }
}
"""


@dataclass
class RoadmapItem:
    id: str
    title: str
    body: str
    status: str | None
    priority: str | None
    kind: str | None  # Type / category field
    url: str | None
    repo: str | None
    is_draft: bool
    updated_at: datetime
    extra: dict = field(default_factory=dict)


def _field_name(field_value: dict) -> str | None:
    f = field_value.get("field") or {}
    return f.get("name")


def _extract_fields(item: dict) -> dict:
    out: dict[str, object] = {}
    for fv in item.get("fieldValues", {}).get("nodes", []) or []:
        name = _field_name(fv)
        if not name:
            continue
        t = fv.get("__typename", "")
        if t == "ProjectV2ItemFieldSingleSelectValue":
            out[name] = fv.get("name")
        elif t == "ProjectV2ItemFieldTextValue":
            out[name] = fv.get("text")
        elif t == "ProjectV2ItemFieldNumberValue":
            out[name] = fv.get("number")
        elif t == "ProjectV2ItemFieldDateValue":
            out[name] = fv.get("date")
    return out


def _pick(fields: dict, *names: str) -> str | None:
    """Case-insensitive name match across alternates."""
    lower = {k.lower(): v for k, v in fields.items()}
    for n in names:
        v = lower.get(n.lower())
        if v is not None:
            return str(v)
    return None


def fetch_project_items(cfg: Config) -> list[RoadmapItem]:
    if cfg.github_project_number is None:
        return []
    if not cfg.github_token:
        raise GitHubError(
            "GITHUB_TOKEN with `read:project` scope is required for Projects v2."
        )

    headers = {
        "Authorization": f"Bearer {cfg.github_token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "evergreenlabs-bot",
    }
    payload = {
        "query": QUERY,
        "variables": {
            "login": cfg.github_username,
            "number": cfg.github_project_number,
        },
    }
    with httpx.Client(timeout=30.0) as client:
        r = client.post(GRAPHQL, headers=headers, json=payload)
    if r.status_code != 200:
        raise GitHubError(f"Projects v2 query failed: HTTP {r.status_code}: {r.text[:200]}")
    body = r.json()
    if body.get("errors"):
        # Surface the first error message — usually 'INSUFFICIENT_SCOPES' or
        # 'Resource not accessible by personal access token'.
        msg = body["errors"][0].get("message", json.dumps(body["errors"]))
        raise GitHubError(f"Projects v2 query errors: {msg}")

    project = ((body.get("data") or {}).get("user") or {}).get("projectV2")
    if not project:
        raise GitHubError(
            f"Project #{cfg.github_project_number} not found under user "
            f"{cfg.github_username}. Check the number and that the token can see it."
        )

    items: list[RoadmapItem] = []
    for node in project.get("items", {}).get("nodes", []) or []:
        content = node.get("content") or {}
        fields = _extract_fields(node)
        is_draft = content.get("__typename") == "DraftIssue"
        repo = (content.get("repository") or {}).get("nameWithOwner")
        items.append(
            RoadmapItem(
                id=node["id"],
                title=content.get("title") or "(untitled)",
                body=(content.get("body") or "").strip(),
                status=_pick(fields, "Status", "State"),
                priority=_pick(fields, "Priority"),
                kind=_pick(fields, "Type", "Kind", "Category"),
                url=content.get("url"),
                repo=repo,
                is_draft=is_draft,
                updated_at=datetime.fromisoformat(
                    node["updatedAt"].replace("Z", "+00:00")
                ),
                extra=fields,
            )
        )
    return items
