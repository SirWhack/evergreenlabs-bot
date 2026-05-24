from __future__ import annotations

import sys

import click
from rich.console import Console

from .config import load_config
from .autorun import run as do_autorun
from .bootstrap import bootstrap_from_website
from .github_client import GitHubError
from .pipelines import introduce as introduce_pipeline
from .pipelines import log_drafter, now_updater, project_sync, roadmap_sync
from .publish import publish as do_publish
from .review import review_loop


console = Console()


class _Group(click.Group):
    def invoke(self, ctx: click.Context):
        try:
            return super().invoke(ctx)
        except GitHubError as e:
            console.print(f"[red]github:[/red] {e}")
            sys.exit(1)
        except RuntimeError as e:
            console.print(f"[red]config:[/red] {e}")
            sys.exit(1)


@click.group(cls=_Group)
def cli() -> None:
    """evergreenlabs-bot: local automation for the evergreenlabs website."""


@cli.command()
def bootstrap() -> None:
    """One-time: import the website's current siteData.js into data/site/."""
    cfg = load_config()
    site = bootstrap_from_website(cfg)
    console.print(
        f"[green]bootstrapped[/green] — {len(site.get('projects', []))} projects, "
        f"{len(site.get('log', []))} log entries imported."
    )


@cli.command("catch-up")
@click.option(
    "--skip-now",
    is_flag=True,
    help="Skip drafting the now.text update.",
)
@click.option(
    "--limit-per-repo",
    default=30,
    show_default=True,
    help="Maximum commits to process per repo on this run.",
)
def catch_up(skip_now: bool, limit_per_repo: int) -> None:
    """Fetch new commits, draft log entries and now.text updates."""
    cfg = load_config()
    console.print("[bold]drafting log entries…[/bold]")
    summary = log_drafter.run(cfg, limit_per_repo=limit_per_repo)
    console.print(
        f"  scanned {summary['repos_scanned']} repos, "
        f"{summary['commits_seen']} new commits, "
        f"[green]{summary['drafts']}[/green] draft(s), "
        f"{summary['skipped']} skipped"
    )
    if not skip_now:
        console.print("[bold]drafting now.text…[/bold]")
        ok = now_updater.run(cfg)
        console.print("  drafted" if ok else "  no candidate")


@cli.command()
def review() -> None:
    """Walk pending drafts interactively (accept / edit / reject)."""
    review_loop()


@cli.command("sync-projects")
def sync_projects() -> None:
    """Auto-sync projects[] metadata from GitHub (no review)."""
    cfg = load_config()
    s = project_sync.sync_projects(cfg)
    console.print(
        f"  scanned {s['scanned']} repos, "
        f"{s['matched']} matched, "
        f"[green]{s['updated']}[/green] updated, "
        f"{s['unintroduced']} unintroduced, "
        f"{s['skiplisted']} on skiplist"
    )
    if s["unintroduced"]:
        console.print(
            f"[dim]{s['unintroduced']} public repo(s) not in projects[]. "
            f"Run `bot introduce` to draft cards for them.[/dim]"
        )


@cli.command()
def introduce() -> None:
    """Draft a project card per unknown public repo (review-gated)."""
    cfg = load_config()
    summary = introduce_pipeline.run(cfg)
    console.print(
        f"  scanned {summary['scanned']} repos, "
        f"{summary['known']} already known, "
        f"{summary['skipped']} on skiplist, "
        f"[green]{summary['drafts']}[/green] new draft(s)"
    )
    if summary["drafts"]:
        console.print("[dim]Next: `bot review` to walk them.[/dim]")


@cli.command("sync-roadmap")
@click.option("--no-commentary", is_flag=True, help="Skip LLM per-item commentary.")
def sync_roadmap(no_commentary: bool) -> None:
    """Pull items from the configured Projects v2 board into data/site/roadmap.json."""
    cfg = load_config()
    s = roadmap_sync.run(cfg, with_commentary=not no_commentary)
    console.print(
        f"  fetched {s['fetched']}, "
        f"[green]{s['kept']}[/green] kept, "
        f"{s['hidden_done']} hidden (done-ish), "
        f"commentary: {s['commentary_new']} new / {s['commentary_cached']} cached"
    )
    if s.get("note"):
        console.print(f"[dim]{s['note']}[/dim]")


@cli.command()
def autorun() -> None:
    """Fully autonomous: sync, introduce, draft, auto-accept (if sane), publish."""
    cfg = load_config()
    s = do_autorun(cfg)
    sync = s["sync"]
    console.print(
        f"sync:        scanned {sync['scanned']}, "
        f"{sync['updated']} updated, "
        f"{sync['unintroduced']} unintroduced"
    )
    console.print(
        f"drafts:      {s['introduced']} introductions, "
        f"{s['log_drafts']} log ({s['log_drafts_skipped']} commits skipped)"
    )
    console.print(
        f"applied:     [green]{s['accepted']}[/green] accepted, "
        f"{s['held_for_review']} held for review"
    )
    console.print(f"publish:     [green]done[/green]" if s["published"] else "publish:     [yellow]skipped[/yellow]")


@cli.command()
def publish() -> None:
    """Regenerate siteData.js from canonical JSON, commit (and optionally push)."""
    cfg = load_config()
    target = do_publish(cfg)
    console.print(f"[green]published[/green] → {target}")


if __name__ == "__main__":
    cli()
