from __future__ import annotations

import os
import subprocess
import tempfile
from typing import Callable

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt
from rich.table import Table

from .drafts import Draft, list_drafts, load_site_part, save_site_part
from .state import add_skip, state_conn


console = Console()


def _render_draft(d: Draft) -> Panel:
    table = Table.grid(padding=(0, 1))
    table.add_column(style="dim")
    table.add_column()
    table.add_row("kind", d.kind)
    table.add_row("repo", d.source_repo or "—")
    table.add_row("commits", ", ".join(c[:7] for c in d.source_commits) or "—")
    if d.notes:
        table.add_row("notes", d.notes)
    if d.kind == "log_entry":
        p = d.payload
        table.add_row("date", f"{p.get('date', '')} {p.get('year', '')}")
        table.add_row("project", p.get("project") or "—")
        table.add_row("body", p.get("body", ""))
    elif d.kind == "now_text":
        p = d.payload
        table.add_row("weekOf", p.get("weekOf", ""))
        table.add_row("text", p.get("text", ""))
    elif d.kind == "project_intro":
        p = d.payload
        table.add_row("slug", p.get("slug", ""))
        table.add_row("title", p.get("title", ""))
        table.add_row("blurb", p.get("blurb", "") or "[dim](empty — fill in on edit)[/dim]")
        table.add_row("tags", ", ".join(p.get("tags", [])) or "—")
        table.add_row("stack", p.get("stack", "") or "—")
        table.add_row("meta", p.get("meta", ""))
        table.add_row("repo", p.get("links", {}).get("repo", ""))
    return Panel(table, title=f"draft {d.id}", border_style="cyan")


def _edit_text(initial: str) -> str:
    editor = os.environ.get("EDITOR", "vi")
    with tempfile.NamedTemporaryFile("w+", suffix=".html", delete=False) as f:
        path = f.name
        f.write(initial)
    try:
        subprocess.run([editor, path], check=True)
        with open(path) as f:
            return f.read().strip()
    finally:
        os.unlink(path)


def _apply_accepted(d: Draft) -> None:
    if d.kind == "log_entry":
        log = load_site_part("log", [])
        # Insert at top (log is newest-first); avoid duplicate by id check.
        log.insert(0, d.payload)
        save_site_part("log", log)
    elif d.kind == "now_text":
        save_site_part("now", d.payload)
    elif d.kind == "project_intro":
        projects = load_site_part("projects", [])
        projects.append(d.payload)
        save_site_part("projects", projects)


def _apply_rejected(d: Draft) -> None:
    if d.kind == "project_intro" and d.source_repo:
        with state_conn() as conn:
            add_skip(conn, d.source_repo, reason="rejected at review")


def review_loop() -> None:
    pending = list_drafts("pending")
    if not pending:
        console.print("[dim]No pending drafts.[/dim]")
        return

    console.print(f"[bold]{len(pending)}[/bold] pending draft(s).\n")
    for d in pending:
        console.print(_render_draft(d))
        choice = Prompt.ask(
            "[a]ccept / [e]dit / [r]eject / [s]kip / [q]uit",
            choices=["a", "e", "r", "s", "q"],
            default="s",
        )
        if choice == "q":
            break
        if choice == "s":
            continue
        if choice == "r":
            d.status = "rejected"
            _apply_rejected(d)
            d.delete()
            console.print("[yellow]rejected[/yellow]\n")
            continue
        if choice == "e":
            if d.kind == "log_entry":
                d.payload["body"] = _edit_text(d.payload.get("body", ""))
            elif d.kind == "now_text":
                d.payload["text"] = _edit_text(d.payload.get("text", ""))
            elif d.kind == "project_intro":
                # Edit the whole payload as JSON for full control.
                import json
                edited = _edit_text(json.dumps(d.payload, indent=2, ensure_ascii=False))
                d.payload = json.loads(edited)
            d.save()
            console.print(_render_draft(d))
            confirm = Prompt.ask("accept now?", choices=["y", "n"], default="y")
            if confirm != "y":
                continue
        d.status = "accepted"
        _apply_accepted(d)
        d.delete()
        console.print("[green]accepted[/green]\n")
