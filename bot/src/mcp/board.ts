// GitHub Projects v2 board access (ADR-0003, revised §D1).
//
// The board is an ORG-OWNED Projects v2 project, but the tracked repos stay
// under the user account. A GitHub App installation is scoped to a single
// account, so it can't span user-repos + org-project. A PAT *you* own is not
// installation-scoped — it reaches both your repos and the org project (org
// admin) — so all board operations use a classic/fine-grained PAT here.
// (Issue create/close/reopen still go through the App; see lib/github.ts.)

export interface BoardEnv {
  /** PAT (project scope) owned by a user who can reach the org project. */
  GITHUB_PAT_PROJECTS: string;
  /** Org login that owns the Projects v2 board. */
  GITHUB_PROJECT_OWNER: string;
  GITHUB_PROJECT_NUMBER?: string;
}

async function patGraphQL<T>(
  env: BoardEnv,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT_PROJECTS}`,
      "Content-Type": "application/json",
      "User-Agent": "evergreenlabs-bot",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Board GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(`Board GraphQL: ${body.errors[0].message}`);
  }
  return body.data as T;
}

interface FieldDef {
  id: string;
  name: string;
  type: "single_select" | "text" | "other";
  options?: Map<string, string>;
}

interface ProjectSchema {
  projectId: string;
  fields: Map<string, FieldDef>;
}

let cachedSchema: ProjectSchema | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function projectNumber(env: BoardEnv): number {
  const num = parseInt(env.GITHUB_PROJECT_NUMBER ?? "", 10);
  if (!num) throw new Error("GITHUB_PROJECT_NUMBER not configured");
  return num;
}

const SCHEMA_QUERY = `
query($login: String!, $number: Int!) {
  organization(login: $login) {
    projectV2(number: $number) {
      id
      fields(first: 50) {
        nodes {
          __typename
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
          ... on ProjectV2Field {
            id
            name
          }
          ... on ProjectV2IterationField {
            id
            name
          }
        }
      }
    }
  }
}`;

interface SchemaFieldNode {
  __typename: string;
  id: string;
  name: string;
  options?: Array<{ id: string; name: string }>;
}

interface SchemaResponse {
  organization: {
    projectV2: {
      id: string;
      fields: { nodes: SchemaFieldNode[] };
    } | null;
  } | null;
}

export async function getProjectSchema(env: BoardEnv): Promise<ProjectSchema> {
  if (cachedSchema && Date.now() < cacheExpiry) return cachedSchema;

  const num = projectNumber(env);
  const data = await patGraphQL<SchemaResponse>(env, SCHEMA_QUERY, {
    login: env.GITHUB_PROJECT_OWNER,
    number: num,
  });

  const project = data.organization?.projectV2;
  if (!project) {
    throw new Error(
      `Project #${num} not found under org ${env.GITHUB_PROJECT_OWNER}`,
    );
  }

  const fields = new Map<string, FieldDef>();
  for (const node of project.fields.nodes) {
    const isSingleSelect = node.__typename === "ProjectV2SingleSelectField";
    const type = isSingleSelect ? ("single_select" as const) : ("text" as const);
    const options =
      isSingleSelect && node.options
        ? new Map(node.options.map((o) => [o.name.toLowerCase(), o.id]))
        : undefined;
    fields.set(node.name.toLowerCase(), {
      id: node.id,
      name: node.name,
      type,
      options,
    });
  }

  cachedSchema = { projectId: project.id, fields };
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return cachedSchema;
}

export function invalidateSchemaCache(): void {
  cachedSchema = null;
  cacheExpiry = 0;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Add an existing issue/PR (by GraphQL content node id) to the board and
 * return the project item id. Idempotent: GitHub returns the existing item
 * if the content is already on the board, so the reconciler can call this
 * unconditionally.
 */
export async function addItemByContentId(
  env: BoardEnv,
  contentNodeId: string,
): Promise<string> {
  const schema = await getProjectSchema(env);
  const data = await patGraphQL<{
    addProjectV2ItemById: { item: { id: string } };
  }>(
    env,
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }`,
    { projectId: schema.projectId, contentId: contentNodeId },
  );
  return data.addProjectV2ItemById.item.id;
}

export async function updateItemField(
  env: BoardEnv,
  itemId: string,
  fieldName: string,
  value: string,
): Promise<void> {
  const schema = await getProjectSchema(env);
  const field = schema.fields.get(fieldName.toLowerCase());
  if (!field) {
    const available = [...schema.fields.keys()].join(", ");
    throw new Error(`Unknown field "${fieldName}". Available: ${available}`);
  }

  let fieldValue: Record<string, unknown>;
  if (field.type === "single_select") {
    const optionId = field.options?.get(value.toLowerCase());
    if (!optionId) {
      const available = field.options
        ? [...field.options.keys()].join(", ")
        : "none";
      throw new Error(
        `Unknown option "${value}" for "${field.name}". Available: ${available}`,
      );
    }
    fieldValue = { singleSelectOptionId: optionId };
  } else {
    fieldValue = { text: value };
  }

  await patGraphQL(
    env,
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value
      }) { projectV2Item { id } }
    }`,
    {
      projectId: schema.projectId,
      itemId,
      fieldId: field.id,
      value: fieldValue,
    },
  );
}

export async function archiveItem(env: BoardEnv, itemId: string): Promise<void> {
  const schema = await getProjectSchema(env);
  await patGraphQL(
    env,
    `mutation($projectId: ID!, $itemId: ID!) {
      archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
        item { id }
      }
    }`,
    { projectId: schema.projectId, itemId },
  );
}

// ---------------------------------------------------------------------------
// Item lookup — resolve a board item id back to its underlying issue + status.
// Needed for the board→issue reconcile direction and for editing title/body.
// ---------------------------------------------------------------------------

export interface ItemRef {
  itemId: string;
  /** owner/name of the backing issue, or null for non-issue content. */
  repo: string | null;
  issueNumber: number | null;
  issueState: "open" | "closed" | null;
  /** Current board Status value, or null if unset. */
  status: string | null;
}

const ITEM_REF_QUERY = `
query($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      id
      content {
        __typename
        ... on Issue { number state repository { nameWithOwner } }
        ... on PullRequest { number state repository { nameWithOwner } }
      }
      fieldValues(first: 20) {
        nodes {
          __typename
          ... on ProjectV2ItemFieldSingleSelectValue {
            name
            field { ... on ProjectV2SingleSelectField { name } }
          }
        }
      }
    }
  }
}`;

interface ItemRefResponse {
  node: {
    id: string;
    content: {
      __typename: string;
      number?: number;
      state?: string;
      repository?: { nameWithOwner: string };
    } | null;
    fieldValues: {
      nodes: Array<{
        __typename: string;
        name?: string;
        field?: { name?: string };
      }>;
    };
  } | null;
}

export async function getItemRef(
  env: BoardEnv,
  itemId: string,
): Promise<ItemRef | null> {
  const data = await patGraphQL<ItemRefResponse>(env, ITEM_REF_QUERY, { itemId });
  const node = data.node;
  if (!node) return null;

  let status: string | null = null;
  for (const fv of node.fieldValues?.nodes ?? []) {
    if (
      fv.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
      fv.field?.name?.toLowerCase() === "status" &&
      fv.name
    ) {
      status = fv.name;
    }
  }

  const content = node.content;
  const state =
    content?.state === "CLOSED" || content?.state === "closed"
      ? ("closed" as const)
      : content?.state === "OPEN" || content?.state === "open"
        ? ("open" as const)
        : null;

  return {
    itemId: node.id,
    repo: content?.repository?.nameWithOwner ?? null,
    issueNumber: content?.number ?? null,
    issueState: state,
    status,
  };
}

// ---------------------------------------------------------------------------
// Query — paginated item list (no LLM commentary, unlike roadmap_sync)
// ---------------------------------------------------------------------------

export interface BoardItem {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  kind: string | null;
  url: string | null;
  repo: string | null;
  isDraft: boolean;
  updatedAt: string;
}

interface ItemFieldValueNode {
  __typename: string;
  name?: string;
  text?: string;
  field?: { name?: string };
}

interface ItemContentNode {
  __typename: string;
  title?: string;
  url?: string;
  repository?: { nameWithOwner: string };
}

interface ItemNode {
  id: string;
  updatedAt: string;
  content: ItemContentNode | null;
  fieldValues: { nodes: ItemFieldValueNode[] };
}

interface ListItemsResponse {
  organization: {
    projectV2: {
      items: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ItemNode[];
      };
    } | null;
  } | null;
}

const LIST_ITEMS_QUERY = `
query($login: String!, $number: Int!, $after: String) {
  organization(login: $login) {
    projectV2(number: $number) {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          updatedAt
          content {
            __typename
            ... on Issue { title url repository { nameWithOwner } }
            ... on PullRequest { title url repository { nameWithOwner } }
            ... on DraftIssue { title }
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
            }
          }
        }
      }
    }
  }
}`;

function extractFieldValues(nodes: ItemFieldValueNode[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const fv of nodes) {
    const fname = fv.field?.name?.toLowerCase();
    if (!fname) continue;
    if (fv.__typename === "ProjectV2ItemFieldSingleSelectValue" && fv.name) {
      out[fname] = fv.name;
    } else if (fv.__typename === "ProjectV2ItemFieldTextValue" && fv.text) {
      out[fname] = fv.text;
    }
  }
  return out;
}

function pickField(
  fields: Record<string, string>,
  ...names: string[]
): string | null {
  for (const n of names) {
    const v = fields[n.toLowerCase()];
    if (v != null) return v;
  }
  return null;
}

export async function listBoardItems(
  env: BoardEnv,
  repoFilter?: string,
  statusFilter?: string,
): Promise<BoardItem[]> {
  const num = parseInt(env.GITHUB_PROJECT_NUMBER ?? "", 10);
  if (!num) return [];

  const out: BoardItem[] = [];
  let after: string | null = null;

  // Paginate the full board — a cross-repo tracker can exceed one page.
  do {
    const data: ListItemsResponse = await patGraphQL<ListItemsResponse>(
      env,
      LIST_ITEMS_QUERY,
      { login: env.GITHUB_PROJECT_OWNER, number: num, after },
    );
    const items = data.organization?.projectV2?.items;
    if (!items) break;

    for (const node of items.nodes) {
      const content = node.content ?? ({} as Partial<ItemContentNode>);
      const fields = extractFieldValues(node.fieldValues?.nodes ?? []);
      const status = pickField(fields, "status", "state") ?? "Untriaged";
      const repo =
        content.repository?.nameWithOwner ??
        pickField(fields, "repo", "repository") ??
        null;

      if (repoFilter) {
        const match =
          repo === repoFilter ||
          repo?.endsWith(`/${repoFilter}`) ||
          repo?.toLowerCase() === repoFilter.toLowerCase();
        if (!match) continue;
      }
      if (statusFilter && status.toLowerCase() !== statusFilter.toLowerCase()) {
        continue;
      }

      out.push({
        id: node.id,
        title: content.title ?? "(untitled)",
        status,
        priority: pickField(fields, "priority"),
        kind: pickField(fields, "type", "kind", "category"),
        url: content.url ?? null,
        repo,
        isDraft: content.__typename === "DraftIssue",
        updatedAt: node.updatedAt,
      });
    }

    after = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
  } while (after);

  return out;
}
