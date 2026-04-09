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

/** 콤마로 여러 이름 가능. 기본 jira_add. Slack은 커스텀 이모지 이름을 소문자로 보냄. */
function targetReactionNames(): string[] {
  const raw = process.env.JIRA_REACTION_EMOJI?.trim() || "jira_add";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function matchesTargetReaction(reaction: string): boolean {
  const r = reaction.trim().toLowerCase();
  return targetReactionNames().includes(r);
}

async function tellUser(
  client: WebClient,
  channel: string,
  user: string,
  text: string
) {
  if (!user) return;
  try {
    await client.chat.postEphemeral({
      channel,
      user,
      text,
    });
  } catch (e) {
    console.error("[slack-jira] postEphemeral failed", e);
  }
}

async function processReactionAdded(event: Record<string, unknown>) {
  const reaction = String(event.reaction ?? "");
  if (!matchesTargetReaction(reaction)) {
    console.log("[slack-jira] skip reaction (name mismatch)", {
      received: reaction,
      expected: targetReactionNames(),
    });
    return;
  }

  const item = event.item as Record<string, unknown> | undefined;
  if (!item || item.type !== "message") return;

  const channel = String(item.channel ?? "");
  const ts = String(item.ts ?? "");
  const reactor = String(event.user ?? "");
  if (!channel || !ts) return;

  const token = requiredEnv("SLACK_BOT_TOKEN");
  const client = new WebClient(token);

  const got = await client.reactions.get({ channel, timestamp: ts });
  if (!got.ok || !got.message) {
    const err = "error" in got ? String(got.error) : "unknown";
    console.error("[slack-jira] reactions.get failed", { err, channel, ts });
    await tellUser(
      client,
      channel,
      reactor,
      `Jira 연동: Slack에서 메시지를 읽지 못했습니다 (\`${err}\`). 이 채널에 봇을 초대했는지, 스레드가 아닌 **채널** 안 메시지인지 확인해 주세요.`
    );
    return;
  }

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

  let host: string;
  let email: string;
  let apiToken: string;
  let projectKey: string;
  try {
    host = requiredEnv("JIRA_HOST");
    email = requiredEnv("JIRA_EMAIL");
    apiToken = requiredEnv("JIRA_API_TOKEN");
    projectKey = requiredEnv("JIRA_PROJECT_KEY");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[slack-jira]", msg);
    await tellUser(
      client,
      channel,
      reactor,
      `Jira 연동 설정 오류: ${msg}. Vercel 환경 변수를 확인해 주세요.`
    );
    return;
  }

  const issueTypeName = process.env.JIRA_ISSUE_TYPE?.trim() || "Task";

  const description = [
    text || "(본문 없음)",
    "",
    "---",
    permalink ? `Slack: ${permalink}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let issue: { key: string };
  try {
    issue = await createJiraIssue({
      host,
      email,
      apiToken,
      projectKey,
      issueTypeName,
      summary: text || "Slack에서 생성",
      description,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[slack-jira] Jira create failed", msg);
    await tellUser(
      client,
      channel,
      reactor,
      `Jira 티켓 생성에 실패했습니다.\n\`\`\`${msg.slice(0, 500)}\`\`\`\n\`JIRA_ISSUE_TYPE\`(프로젝트에 있는 이슈 유형 이름)과 프로젝트 키를 확인해 주세요.`
    );
    return;
  }

  const url = jiraBrowseUrl(host, issue.key);
  const threadTs = message.thread_ts ?? message.ts ?? ts;

  const posted = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `Jira 티켓이 생성되었습니다: *<${url}|${issue.key}>*`,
  });
  if (!posted.ok) {
    const err = "error" in posted ? String(posted.error) : "unknown";
    console.error("[slack-jira] postMessage failed", err);
    await tellUser(
      client,
      channel,
      reactor,
      `티켓은 생성되었습니다 (${issue.key})이나 스레드에 답글을 못 남겼습니다: \`${err}\``
    );
  }
}

/**
 * 브라우저 주소창·일부 모니터가 GET으로 칠 때 Vercel이
 * INVALID_REQUEST_METHOD(405)를 내는 경우가 있어, 안내 응답을 둡니다.
 * Slack 이벤트는 항상 POST로 옵니다.
 */
export async function GET() {
  return Response.json(
    {
      ok: true,
      hint: "Slack Event Subscriptions는 POST만 사용합니다. 주소창으로 연 것이면 이 응답은 정상입니다.",
    },
    { status: 200 }
  );
}

export async function HEAD() {
  return new Response(null, { status: 200 });
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
