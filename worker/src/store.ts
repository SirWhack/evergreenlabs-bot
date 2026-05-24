const SEEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const LIST_LIMIT = 100;
const DELETE_SCAN_LIMIT = 1000;

export interface EventRecord {
  delivery_id: string;
  event: string;
  action?: string;
  repo?: string;
  sha?: string;
  branch?: string;
  ts: string;
}

export async function isSeen(kv: KVNamespace, deliveryId: string): Promise<boolean> {
  const v = await kv.get(`seen:${deliveryId}`);
  return v !== null;
}

export async function markSeen(kv: KVNamespace, deliveryId: string): Promise<void> {
  await kv.put(`seen:${deliveryId}`, "1", { expirationTtl: SEEN_TTL_SECONDS });
}

export async function enqueue(kv: KVNamespace, record: EventRecord): Promise<void> {
  await kv.put(`queue:${record.ts}:${record.delivery_id}`, JSON.stringify(record));
}

export async function listEvents(kv: KVNamespace): Promise<EventRecord[]> {
  const { keys } = await kv.list({ prefix: "queue:", limit: LIST_LIMIT });
  const records = await Promise.all(
    keys.map(async (k) => {
      const v = await kv.get(k.name);
      return v ? (JSON.parse(v) as EventRecord) : null;
    }),
  );
  return records.filter((r): r is EventRecord => r !== null);
}

export async function deleteEvents(kv: KVNamespace, deliveryIds: string[]): Promise<number> {
  if (deliveryIds.length === 0) return 0;
  const wanted = new Set(deliveryIds);
  const { keys } = await kv.list({ prefix: "queue:", limit: DELETE_SCAN_LIMIT });
  const toDelete = keys.filter((k) => {
    const id = k.name.split(":").pop();
    return id !== undefined && wanted.has(id);
  });
  await Promise.all(toDelete.map((k) => kv.delete(k.name)));
  return toDelete.length;
}
