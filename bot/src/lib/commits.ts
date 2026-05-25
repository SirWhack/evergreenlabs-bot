import type { PendingEvent } from "./state";

export interface DrainedCommit {
  sha: string;
  repoFullName: string;
  repoShortName: string;
}

export function extractUniqueCommits(
  pendingEvents: PendingEvent[],
  repoFullName: string,
  repoShortName: string,
): DrainedCommit[] {
  const seen = new Set<string>();
  const out: DrainedCommit[] = [];
  for (const ev of pendingEvents) {
    if (ev.event !== "push") continue;
    const payload = ev.payload as { commits?: Array<{ id?: string }> } | null | undefined;
    const commits = payload?.commits ?? [];
    for (const c of commits) {
      const sha = c?.id;
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);
      out.push({ sha, repoFullName, repoShortName });
    }
  }
  return out;
}
