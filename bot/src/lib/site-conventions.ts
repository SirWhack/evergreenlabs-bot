export const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

export const SKIP_NAMES = new Set<string>(["evergreenlabs"]);

export function metaString(pushedAtIso: string): string {
  const d = new Date(pushedAtIso);
  const month = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return `updated ${month} ${year}`;
}

export function shortDate(iso: string): { date: string; year: string } {
  const d = new Date(iso);
  const month = MONTHS[d.getUTCMonth()];
  const day = String(d.getUTCDate()).padStart(2, "0");
  return { date: `${month} ${day}`, year: String(d.getUTCFullYear()) };
}

export function normalizeTags(topics: readonly string[], language: string | null): string[] {
  const out = topics.slice(0, 4).map((t) => t.toUpperCase().replace(/-/g, " "));
  if (out.length === 0 && language) {
    return [language.toUpperCase()];
  }
  return out;
}

export function currentWeekOf(): string {
  const now = new Date();
  const month = MONTHS[now.getUTCMonth()];
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${month} ${day}`;
}
