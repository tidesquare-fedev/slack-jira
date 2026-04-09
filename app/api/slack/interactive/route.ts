import { verifySlackRequest } from "@/lib/slack-verify";
import {
  handleBlockActions,
  handleViewSubmissionJira,
} from "@/lib/process-reaction";

export const runtime = "nodejs";

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
    request.headers.get("x-slack-signature"),
  );
  if (!ok) {
    return new Response("invalid signature", { status: 401 });
  }

  let payloadStr: string;
  try {
    const params = new URLSearchParams(rawBody);
    const p = params.get("payload");
    if (!p) {
      return new Response("missing payload", { status: 400 });
    }
    payloadStr = p;
  } catch {
    return new Response("bad form body", { status: 400 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadStr) as Record<string, unknown>;
  } catch {
    return new Response("bad payload json", { status: 400 });
  }

  const type = payload.type as string;

  if (type === "block_actions") {
    const err = await handleBlockActions(
      payload as Parameters<typeof handleBlockActions>[0],
    );
    if (err.error) {
      console.error("handleBlockActions:", err.error);
    }
    return new Response("", { status: 200 });
  }

  if (type === "view_submission") {
    const { responseBody } = await handleViewSubmissionJira(
      payload as Parameters<typeof handleViewSubmissionJira>[0],
    );
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("", { status: 200 });
}

export async function GET() {
  return new Response("POST Slack interactivity here", { status: 200 });
}
