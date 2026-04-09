export type SlackMessage = {
  text?: string;
  thread_ts?: string;
  ts: string;
  user?: string;
};

export function plainToJiraAdf(text: string) {
  const safe = text.trim() || "(내용 없음)";
  return {
    type: "doc" as const,
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: safe }],
      },
    ],
  };
}

export async function slackApiForm<T>(
  token: string,
  method: string,
  params: Record<string, string>,
): Promise<T & { ok: boolean; error?: string }> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  return res.json() as Promise<T & { ok: boolean; error?: string }>;
}

export async function slackApiJson<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T & { ok: boolean; error?: string }> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T & { ok: boolean; error?: string }>;
}

export async function fetchMessage(
  token: string,
  channel: string,
  ts: string,
): Promise<SlackMessage> {
  const data = await slackApiForm<{
    messages?: SlackMessage[];
  }>(token, "conversations.history", {
    channel,
    latest: ts,
    oldest: ts,
    inclusive: "true",
    limit: "1",
  });
  if (!data.ok || !data.messages?.[0]) {
    throw new Error(`conversations.history: ${data.error ?? "no message"}`);
  }
  return data.messages[0];
}

export async function getPermalink(
  token: string,
  channel: string,
  ts: string,
): Promise<string | null> {
  const data = await slackApiForm<{ permalink?: string }>(
    token,
    "chat.getPermalink",
    { channel, message_ts: ts },
  );
  return data.ok && data.permalink ? data.permalink : null;
}

export async function postThreadReply(
  token: string,
  channel: string,
  threadTs: string,
  text: string,
) {
  const data = await slackApiForm(token, "chat.postMessage", {
    channel,
    thread_ts: threadTs,
    text,
  });
  if (!data.ok) {
    console.error("chat.postMessage failed:", data.error);
  }
}

function jiraBasicHeader(email: string, apiToken: string) {
  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
  return {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  } as const;
}

export type JiraAssignableUser = {
  accountId: string;
  displayName?: string;
  emailAddress?: string;
  active?: boolean;
};

/** 프로젝트에 배정 가능한 사용자 검색(이메일·이름) */
export async function jiraSearchAssignableUsers(args: {
  host: string;
  email: string;
  apiToken: string;
  projectKey: string;
  query: string;
}): Promise<JiraAssignableUser[]> {
  const q = encodeURIComponent(args.query.trim());
  const url = `https://${args.host}/rest/api/3/user/assignable/search?project=${encodeURIComponent(args.projectKey)}&query=${q}&maxResults=50`;
  const res = await fetch(url, {
    headers: jiraBasicHeader(args.email, args.apiToken),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Jira assignable/search ${res.status}: ${t}`);
  }
  const json = await res.json();
  return Array.isArray(json) ? (json as JiraAssignableUser[]) : [];
}

/** assignable/search 가 비었을 때: 프로젝트 맥락의 사용자 검색(담당자 해석에 사용) */
export async function jiraSearchUsersInProject(args: {
  host: string;
  email: string;
  apiToken: string;
  projectKey: string;
  query: string;
}): Promise<JiraAssignableUser[]> {
  const q = encodeURIComponent(args.query.trim());
  const pk = encodeURIComponent(args.projectKey);
  const url = `https://${args.host}/rest/api/3/user/search?query=${q}&projectKeys=${pk}&maxResults=50`;
  const res = await fetch(url, {
    headers: jiraBasicHeader(args.email, args.apiToken),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Jira user/search ${res.status}: ${t}`);
  }
  const arr = (await res.json()) as {
    accountId?: string;
    accountType?: string;
    displayName?: string;
    emailAddress?: string;
    active?: boolean;
  }[];
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(
      (u) =>
        typeof u.accountId === "string" &&
        u.accountId &&
        u.accountType !== "app",
    )
    .map((u) => ({
      accountId: u.accountId as string,
      displayName: u.displayName,
      emailAddress: u.emailAddress,
      active: u.active,
    }));
}

export async function jiraGetUserByAccountId(args: {
  host: string;
  email: string;
  apiToken: string;
  accountId: string;
}): Promise<JiraAssignableUser | null> {
  const id = encodeURIComponent(args.accountId.trim());
  const url = `https://${args.host}/rest/api/3/user?accountId=${id}`;
  const res = await fetch(url, { headers: jiraBasicHeader(args.email, args.apiToken) });
  if (!res.ok) return null;
  const u = (await res.json()) as {
    accountId?: string;
    displayName?: string;
    emailAddress?: string;
    active?: boolean;
  };
  if (!u.accountId) return null;
  return {
    accountId: u.accountId,
    displayName: u.displayName,
    emailAddress: u.emailAddress,
    active: u.active,
  };
}

export function jiraPickAssignee(
  candidates: JiraAssignableUser[],
  query: string,
): JiraAssignableUser | null {
  if (!candidates.length) return null;
  const qLower = query.toLowerCase().trim();
  const pool = candidates.some((u) => u.active !== false)
    ? candidates.filter((u) => u.active !== false)
    : candidates;
  const exactEmail = pool.find((u) => u.emailAddress?.toLowerCase() === qLower);
  if (exactEmail) return exactEmail;
  const exactName = pool.find((u) => u.displayName?.toLowerCase() === qLower);
  if (exactName) return exactName;
  const partial = pool.find(
    (u) =>
      (u.displayName?.toLowerCase().includes(qLower) ?? false) ||
      (u.emailAddress?.toLowerCase().includes(qLower) ?? false),
  );
  if (partial) return partial;
  return pool[0] ?? null;
}

/** 담당자 입력(이메일·이름·accountId) → 사용자 */
export async function jiraResolveAssigneeAccountId(args: {
  host: string;
  email: string;
  apiToken: string;
  projectKey: string;
  query: string;
}): Promise<JiraAssignableUser | null> {
  const q = args.query.trim();
  if (!q) return null;

  const byId = await jiraGetUserByAccountId({
    host: args.host,
    email: args.email,
    apiToken: args.apiToken,
    accountId: q,
  });
  if (byId) return byId;

  let pool: JiraAssignableUser[] = [];
  try {
    pool = await jiraSearchAssignableUsers(args);
  } catch (e) {
    console.warn("jiraSearchAssignableUsers:", e);
  }
  if (!pool.length) {
    try {
      pool = await jiraSearchUsersInProject(args);
    } catch (e) {
      console.warn("jiraSearchUsersInProject:", e);
    }
  }
  return jiraPickAssignee(pool, q);
}

export type JiraSprint = { id: number; name: string; state?: string };

export async function jiraListActiveAndFutureSprints(args: {
  host: string;
  email: string;
  apiToken: string;
  boardId: number;
}): Promise<JiraSprint[]> {
  const url = `https://${args.host}/rest/agile/1.0/board/${args.boardId}/sprint?state=active,future&maxResults=50`;
  const res = await fetch(url, {
    headers: { ...jiraBasicHeader(args.email, args.apiToken) },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Jira agile/sprint ${res.status}: ${t}`);
  }
  const json = (await res.json()) as { values?: JiraSprint[] };
  return json.values ?? [];
}

export async function jiraAddIssuesToSprint(args: {
  host: string;
  email: string;
  apiToken: string;
  sprintId: number;
  issueKeys: string[];
}): Promise<void> {
  const url = `https://${args.host}/rest/agile/1.0/sprint/${args.sprintId}/issue`;
  const res = await fetch(url, {
    method: "POST",
    headers: jiraBasicHeader(args.email, args.apiToken),
    body: JSON.stringify({ issues: args.issueKeys }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Jira sprint/issue ${res.status}: ${t}`);
  }
}

function jiraErrorMentionsAssignee(status: number, body: string): boolean {
  if (status !== 400) return false;
  try {
    const j = JSON.parse(body) as { errors?: Record<string, string> };
    return Boolean(j.errors?.assignee);
  } catch {
    return /"assignee"|assignee/i.test(body);
  }
}

export async function createJiraIssue(args: {
  host: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueType: string;
  summary: string;
  descriptionAdf: ReturnType<typeof plainToJiraAdf>;
  assigneeAccountId?: string | null;
}): Promise<{ key: string; self: string }> {
  const fields: Record<string, unknown> = {
    project: { key: args.projectKey },
    summary: args.summary.slice(0, 254),
    description: args.descriptionAdf,
    issuetype: { name: args.issueType },
  };
  if (args.assigneeAccountId) {
    fields.assignee = { accountId: args.assigneeAccountId };
  }

  const url = `https://${args.host}/rest/api/3/issue`;
  const headers = jiraBasicHeader(args.email, args.apiToken);

  let res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const errText = await res.text();
    if (
      args.assigneeAccountId &&
      jiraErrorMentionsAssignee(res.status, errText)
    ) {
      const fieldsRetry = {
        ...fields,
        assignee: { id: args.assigneeAccountId },
      };
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ fields: fieldsRetry }),
      });
      if (res.ok) {
        return (await res.json()) as { key: string; self: string };
      }
      const t2 = await res.text();
      throw new Error(`Jira ${res.status}: ${t2}`);
    }
    throw new Error(`Jira ${res.status}: ${errText}`);
  }

  return (await res.json()) as { key: string; self: string };
}

/** 이슈 생성 실패 시 Slack 모달 필드 매핑용 */
export function jiraParseCreateIssueErrorForSlack(
  message: string,
): { block: "assignee_block" | "summary_block"; text: string } | null {
  const m = message.match(/^Jira (\d+): ([\s\S]+)$/);
  const body = m?.[2] ?? message;
  try {
    const j = JSON.parse(body) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
    };
    const assigneeErr = j.errors?.assignee;
    if (assigneeErr) {
      return {
        block: "assignee_block",
        text:
          assigneeErr.length > 140
            ? `${assigneeErr.slice(0, 137)}…`
            : assigneeErr,
      };
    }
    const msgs = j.errorMessages?.filter(Boolean);
    if (msgs?.length) {
      const t = msgs.join(" ");
      if (/assignee|담당|배정|user/i.test(t)) {
        return {
          block: "assignee_block",
          text: t.length > 140 ? `${t.slice(0, 137)}…` : t,
        };
      }
    }
  } catch {
    /* not json */
  }
  if (/assignee|Assignee|배정|담당자/i.test(body)) {
    return {
      block: "assignee_block",
      text: body.length > 140 ? `${body.slice(0, 137)}…` : body,
    };
  }
  return null;
}

export function summaryFromMessage(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? text;
  const trimmed = line.trim().slice(0, 120);
  return trimmed || "Slack에서 생성된 티켓";
}
