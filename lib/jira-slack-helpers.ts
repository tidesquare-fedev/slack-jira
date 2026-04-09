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
  const url = `https://${args.host}/rest/api/3/user/assignable/search?project=${encodeURIComponent(args.projectKey)}&query=${q}&maxResults=20`;
  const res = await fetch(url, {
    headers: {
      ...jiraBasicHeader(args.email, args.apiToken),
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Jira assignable/search ${res.status}: ${t}`);
  }
  return res.json() as Promise<JiraAssignableUser[]>;
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

  const res = await fetch(`https://${args.host}/rest/api/3/issue`, {
    method: "POST",
    headers: jiraBasicHeader(args.email, args.apiToken),
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Jira ${res.status}: ${errText}`);
  }
  const json = (await res.json()) as { key: string; self: string };
  return json;
}

export function summaryFromMessage(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? text;
  const trimmed = line.trim().slice(0, 120);
  return trimmed || "Slack에서 생성된 티켓";
}
