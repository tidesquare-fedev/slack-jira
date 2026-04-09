import { waitUntil } from "@vercel/functions";
import { verifySlackRequest } from "@/lib/slack-verify";
import { sendJiraFormInvite } from "@/lib/process-reaction";

export const runtime = "nodejs";

const TARGET_REACTION =
  process.env.SLACK_REACTION_NAME?.trim().replace(/^:|:$/g, "") ?? "jira_add";

type UrlVerification = { type: "url_verification"; challenge: string };

type EventCallback = {
  type: "event_callback";
  token: string;
  team_id: string;
  api_app_id: string;
  event?: { type: string; [k: string]: unknown };
  event_id?: string;
};

function isUrlVerification(body: unknown): body is UrlVerification {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as UrlVerification).type === "url_verification" &&
    typeof (body as UrlVerification).challenge === "string"
  );
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) {
    return new Response("SLACK_SIGNING_SECRET missing", { status: 500 });
  }

  const ok = verifySlackRequest(
    secret,
    rawBody,
    request.headers.get("x-slack-request-timestamp"),
    request.headers.get("x-slack-signature")
  );
  if (!ok) {
    return new Response("invalid signature", { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  if (isUrlVerification(parsed)) {
    return new Response(parsed.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const cb = parsed as EventCallback;
  if (cb.type !== "event_callback" || !cb.event) {
    return new Response("", { status: 200 });
  }

  const ev = cb.event as {
    type: string;
    reaction?: string;
    user?: string;
    item?: { type: string; channel?: string; ts?: string };
  };
  if (
    ev.type === "reaction_added" &&
    ev.reaction === TARGET_REACTION &&
    ev.item?.type === "message" &&
    ev.item.channel &&
    ev.item.ts
  ) {
    waitUntil(
      sendJiraFormInvite({
        channel: ev.item.channel,
        messageTs: ev.item.ts,
        reactorUserId: ev.user ?? "",
      }).catch((err) => {
        console.error("sendJiraFormInvite failed", err);
      }),
    );
  }

  return new Response("", { status: 200 });
}

export async function GET() {
  return new Response("POST Slack events here", { status: 200 });
}
