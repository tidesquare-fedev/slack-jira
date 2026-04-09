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

export async function createJiraIssue(args: {
  host: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueType: string;
  summary: string;
  descriptionAdf: ReturnType<typeof plainToJiraAdf>;
}): Promise<{ key: string; self: string }> {
  const auth = Buffer.from(`${args.email}:${args.apiToken}`).toString(
    "base64",
  );
  const res = await fetch(`https://${args.host}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      fields: {
        project: { key: args.projectKey },
        summary: args.summary.slice(0, 254),
        description: args.descriptionAdf,
        issuetype: { name: args.issueType },
      },
    }),
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
