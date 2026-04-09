import { waitUntil } from "@vercel/functions";
import { WebClient } from "@slack/web-api";
import { verifySlackSignature } from "@/lib/slack-verify";
import { createJiraIssue, jiraBrowseUrl } from "@/lib/jira";
import { messagePlainText } from "@/lib/slack-message";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function processReactionAdded(event: Record<string, unknown>) {
  const targetEmoji =
    process.env.JIRA_REACTION_EMOJI?.trim() || "jira_add";
  const reaction = String(event.reaction ?? "");
  if (reaction !== targetEmoji) return;

  const item = event.item as Record<string, unknown> | undefined;
  if (!item || item.type !== "message") return;

  const channel = String(item.channel ?? "");
  const ts = String(item.ts ?? "");
  if (!channel || !ts) return;

  const token = requiredEnv("SLACK_BOT_TOKEN");
  const client = new WebClient(token);

  const got = await client.reactions.get({ channel, timestamp: ts });
  if (!got.ok || !got.message) return;

  const message = got.message as {
    text?: string;
    thread_ts?: string;
    ts?: string;
    blocks?: unknown[];
  };

  const text = messagePlainText(message);
  const permalinkRes = await client.chat.getPermalink({
    channel,
    message_ts: ts,
  });
  const permalink =
    permalinkRes.ok && permalinkRes.permalink ? permalinkRes.permalink : "";

  const host = requiredEnv("JIRA_HOST");
  const email = requiredEnv("JIRA_EMAIL");
  const apiToken = requiredEnv("JIRA_API_TOKEN");
  const projectKey = requiredEnv("JIRA_PROJECT_KEY");
  const issueTypeName = process.env.JIRA_ISSUE_TYPE?.trim() || "Task";

  const description = [
    text || "(본문 없음)",
    "",
    "---",
    permalink ? `Slack: ${permalink}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const issue = await createJiraIssue({
    host,
    email,
    apiToken,
    projectKey,
    issueTypeName,
    summary: text || "Slack에서 생성",
    description,
  });

  const url = jiraBrowseUrl(host, issue.key);
  const threadTs = message.thread_ts ?? message.ts ?? ts;

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `Jira 티켓이 생성되었습니다: *<${url}|${issue.key}>*`,
  });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";

  const valid = verifySlackSignature(
    signingSecret,
    request.headers.get("x-slack-signature"),
    request.headers.get("x-slack-request-timestamp"),
    rawBody
  );

  if (!valid) {
    return new Response("invalid signature", { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  if (body.type === "url_verification") {
    const challenge = body.challenge;
    if (typeof challenge === "string") {
      return Response.json({ challenge });
    }
    return new Response("missing challenge", { status: 400 });
  }

  if (body.type === "event_callback") {
    const ev = body.event;
    if (ev && typeof ev === "object" && !Array.isArray(ev)) {
      const event = ev as Record<string, unknown>;
      waitUntil(
        (async () => {
          try {
            if (event.type === "reaction_added") {
              await processReactionAdded(event);
            }
          } catch (err) {
            console.error("[slack-jira]", err);
          }
        })()
      );
    }
    return new Response("", { status: 200 });
  }

  return new Response("", { status: 200 });
}
