import {
  buildChecklistSlashResponse,
  parseChecklistSlashInput,
} from "@/lib/checklist";
import { verifySlackRequest } from "@/lib/slack-verify";

export const runtime = "nodejs";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
} as const;

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
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
    request.headers.get("x-slack-signature"),
  );
  if (!ok) {
    return new Response("invalid signature", { status: 401 });
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(rawBody);
  } catch {
    return new Response("bad form body", { status: 400 });
  }

  const command = params.get("command")?.trim() ?? "";
  const text = params.get("text") ?? "";
  const userId = params.get("user_id") ?? "";

  if (command !== "/check") {
    return jsonResponse({
      response_type: "ephemeral",
      text: "지원하지 않는 명령입니다. `/check` 만 사용할 수 있습니다.",
    });
  }

  const { lines, mentionUserIds } = parseChecklistSlashInput(text);
  if (lines.length === 0) {
    return jsonResponse({
      response_type: "ephemeral",
      text:
        "체크할 항목을 입력해 주세요.\n• 한 줄에 하나씩, 줄바꿈(Enter)으로만 나눕니다. 문장 안 쉼표는 그대로 쓸 수 있습니다.\n• @로 사람을 멘션하면 메시지에 알림이 갑니다. (항목 줄 안에 넣어도 됩니다)\n• 예: \"@홍길동 할 일 검토\" 한 줄 또는 맨 위 줄에 멘션만 두고 그 아래에 항목\n• 최대 10개까지 표시됩니다.",
    });
  }

  return jsonResponse(
    buildChecklistSlashResponse(lines, userId, mentionUserIds),
  );
}

export async function GET() {
  return new Response("POST Slack slash commands (/check) here", {
    status: 200,
  });
}
