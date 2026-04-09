type AdfDoc = {
  type: "doc";
  version: 1;
  content: Array<{
    type: "paragraph";
    content: Array<{ type: "text"; text: string }>;
  }>;
};

function plainTextToAdf(text: string): AdfDoc {
  const lines = text.split(/\r?\n/);
  const content = lines.map((line) => ({
    type: "paragraph" as const,
    content: [{ type: "text" as const, text: line || " " }],
  }));
  return { type: "doc", version: 1, content };
}

function summarize(text: string, max = 120): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one || "(내용 없음)";
  return `${one.slice(0, max - 1)}…`;
}

export async function createJiraIssue(params: {
  host: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueTypeName: string;
  summary: string;
  description: string;
}): Promise<{ key: string; self: string }> {
  const { host, email, apiToken, projectKey, issueTypeName, summary, description } =
    params;
  const base = host.replace(/\/$/, "");
  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

  const body = {
    fields: {
      project: { key: projectKey },
      summary: summarize(summary, 255),
      description: plainTextToAdf(description),
      issuetype: { name: issueTypeName },
    },
  };

  const res = await fetch(`${base}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Jira ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as { key: string; self: string };
  return { key: data.key, self: data.self };
}

export function jiraBrowseUrl(host: string, issueKey: string): string {
  const base = host.replace(/\/$/, "");
  return `${base}/browse/${issueKey}`;
}
