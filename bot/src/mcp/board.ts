// GitHub Projects v2 GraphQL mutations for board management.
// Uses GITHUB_PAT_PROJECTS (classic PAT) because GitHub Apps
// cannot access user-owned Projects v2.

export interface BoardEnv {
  GITHUB_PAT_PROJECTS: string;
  GITHUB_USERNAME: string;
  GITHUB_PROJECT_NUMBER?: string;
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
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(`GraphQL: ${body.errors[0].message}`);
  }
  return body.data as T;
}

const SCHEMA_QUERY = `
query($login: String!, $number: Int!) {
  user(login: $login) {
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
  user: {
    projectV2: {
      id: string;
      fields: { nodes: SchemaFieldNode[] };
    } | null;
  };
}

export async function getProjectSchema(env: BoardEnv): Promise<ProjectSchema> {
  if (cachedSchema && Date.now() < cacheExpiry) return cachedSchema;

  const num = parseInt(env.GITHUB_PROJECT_NUMBER ?? "", 10);
  if (!num) throw new Error("GITHUB_PROJECT_NUMBER not configured");

  const data = await patGraphQL<SchemaResponse>(env, SCHEMA_QUERY, {
    login: env.GITHUB_USERNAME,
    number: num,
  });

  const project = data.user?.projectV2;
  if (!project) throw new Error(`Project #${num} not found`);

  const fields = new Map<string, FieldDef>();
  for (const node of project.fields.nodes) {
    const isSingleSelect =
      node.__typename === "ProjectV2SingleSelectField";
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

export async function createDraftItem(
  env: BoardEnv,
  title: string,
): Promise<string> {
  const schema = await getProjectSchema(env);
  const data = await patGraphQL<{
    addProjectV2DraftIssue: { projectItem: { id: string } };
  }>(
    env,
    `mutation($projectId: ID!, $title: String!) {
      addProjectV2DraftIssue(input: { projectId: $projectId, title: $title }) {
        projectItem { id }
      }
    }`,
    { projectId: schema.projectId, title },
  );
  return data.addProjectV2DraftIssue.projectItem.id;
}

export interface IssueItemEnv extends BoardEnv {
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
}

export async function createIssueAndAddToBoard(
  env: IssueItemEnv,
  repo: string,
  title: string,
  body?: string,
): Promise<{ itemId: string; issueUrl: string; issueNodeId: string }> {
  const { ghFetch } = await import("../lib/github");

  const res = await ghFetch(env, `/repos/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body: body ?? "" }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create issue in ${repo}: ${res.status} ${await res.text()}`);
  }
  const issue = (await res.json()) as {
    node_id: string;
    html_url: string;
  };

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
    { projectId: schema.projectId, contentId: issue.node_id },
  );

  return {
    itemId: data.addProjectV2ItemById.item.id,
    issueUrl: issue.html_url,
    issueNodeId: issue.node_id,
  };
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
    throw new Error(
      `Unknown field "${fieldName}". Available: ${available}`,
    );
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

export async function archiveItem(
  env: BoardEnv,
  itemId: string,
): Promise<void> {
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
// Query — lightweight item list (no LLM commentary, unlike roadmap_sync)
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
  user: {
    projectV2: {
      items: { nodes: ItemNode[] };
    } | null;
  };
}

const LIST_ITEMS_QUERY = `
query($login: String!, $number: Int!) {
  user(login: $login) {
    projectV2(number: $number) {
      items(first: 100) {
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

function extractFieldValues(
  nodes: ItemFieldValueNode[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const fv of nodes) {
    const fname = fv.field?.name?.toLowerCase();
    if (!fname) continue;
    if (
      fv.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
      fv.name
    ) {
      out[fname] = fv.name;
    } else if (
      fv.__typename === "ProjectV2ItemFieldTextValue" &&
      fv.text
    ) {
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

  const data = await patGraphQL<ListItemsResponse>(env, LIST_ITEMS_QUERY, {
    login: env.GITHUB_USERNAME,
    number: num,
  });

  const nodes = data.user?.projectV2?.items?.nodes ?? [];
  const out: BoardItem[] = [];

  for (const node of nodes) {
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

  return out;
}
