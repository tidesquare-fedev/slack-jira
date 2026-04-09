import { slackApiForm } from "@/lib/jira-slack-helpers";

/** Slack checkboxes 요소당 최대 옵션 수 */
const MAX_ITEMS = 10;

/** Slack 사용자 멘션 `<@U…>` / `<@U…|표시명>` (워크스페이스 멤버는 U, 게스트 등 W) */
const SLACK_USER_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g;

export const CHECKLIST_CHECKBOX_ACTION_ID = "checklist_checkbox_toggle";

export type ChecklistBlockActionPayload = {
  type: "block_actions";
  channel?: { id?: string };
  message?: { ts?: string; blocks?: unknown[] };
  actions?: {
    action_id: string;
    selected_options?: { value: string }[];
  }[];
};

/** 본문에서 Slack 사용자 멘션 ID만 순서 유지해 수집 */
export function extractSlackUserMentions(text: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const re = new RegExp(SLACK_USER_MENTION_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

/** 체크박스 라벨용: 멘션 토큰 제거 후 공백 정리 (plain_text에는 멘션이 동작하지 않음) */
export function stripSlackUserMentions(text: string): string {
  return text
    .replace(SLACK_USER_MENTION_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type ParsedChecklistSlashInput = {
  /** 체크 항목 라벨 (멘션 토큰 제거) */
  lines: string[];
  /** 메시지에 mrkdwn으로 넣어 실제 알림이 가는 사용자 ID */
  mentionUserIds: string[];
};

/**
 * `/check` 뒤 텍스트 파싱: 줄바꿈으로 항목 구분, 본문의 `<@U…>` 멘션은 알림용으로 수집하고
 * 각 줄 라벨에서는 제거합니다.
 */
export function parseChecklistSlashInput(text: string): ParsedChecklistSlashInput {
  const raw = text.trim();
  if (!raw) {
    return { lines: [], mentionUserIds: [] };
  }

  const mentionUserIds = extractSlackUserMentions(raw);

  const lines = raw
    .split(/\r?\n/)
    .map((l) => stripSlackUserMentions(l))
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS);

  return { lines, mentionUserIds };
}

/** @deprecated 줄 단위만 필요할 때는 `parseChecklistSlashInput` 사용 권장 */
export function parseChecklistLines(text: string): string[] {
  return parseChecklistSlashInput(text).lines;
}

/** 슬래시 커맨드 즉시 응답 JSON (본문만 JSON.stringify 해서 반환) */
export function buildChecklistSlashResponse(
  lines: string[],
  userId: string,
  mentionUserIds: string[] = [],
): Record<string, unknown> {
  const options = lines.map((line, i) => ({
    text: {
      type: "plain_text" as const,
      text: line.length > 75 ? `${line.slice(0, 72)}…` : line,
    },
    value: String(i),
  }));

  const blocks: Record<string, unknown>[] = [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<@${userId}>님이 만든 체크리스트`,
        },
      ],
    },
  ];

  if (mentionUserIds.length > 0) {
    const mentionText = mentionUserIds.map((id) => `<@${id}>`).join(" ");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `함께 확인해 주세요: ${mentionText}`,
      },
    });
  }

  blocks.push(
    { type: "divider" },
    {
      type: "actions",
      block_id: "checklist_actions",
      elements: [
        {
          type: "checkboxes",
          action_id: CHECKLIST_CHECKBOX_ACTION_ID,
          options,
        },
      ],
    },
  );

  const mentionSummary =
    mentionUserIds.length > 0 ? ` · 멘션 ${mentionUserIds.length}명` : "";

  return {
    response_type: "in_channel",
    text: `체크리스트 (${lines.length}개 항목)${mentionSummary}`,
    blocks,
  };
}

function applyChecklistSelectionToBlocks(
  blocks: unknown[],
  selected: Set<string>,
): unknown[] {
  return blocks.map((block) => {
    if (typeof block !== "object" || block === null) return block;
    const b = block as {
      type?: string;
      elements?: unknown[];
    };
    if (b.type !== "actions" || !Array.isArray(b.elements)) {
      return block;
    }
    return {
      ...b,
      elements: b.elements.map((el) => {
        if (typeof el !== "object" || el === null) return el;
        const e = el as {
          type?: string;
          action_id?: string;
          options?: { text: unknown; value: string }[];
        };
        if (
          e.type === "checkboxes" &&
          e.action_id === CHECKLIST_CHECKBOX_ACTION_ID &&
          Array.isArray(e.options)
        ) {
          const initial_options = e.options.filter((o) =>
            selected.has(o.value),
          );
          return { ...el, initial_options };
        }
        return el;
      }),
    };
  });
}

export async function handleChecklistCheckboxAction(
  payload: ChecklistBlockActionPayload,
): Promise<{ error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = payload.channel?.id;
  const ts = payload.message?.ts;
  const blocks = payload.message?.blocks;

  if (!token || !channel || !ts) {
    return { error: "Missing channel/message context" };
  }
  if (!Array.isArray(blocks)) {
    return { error: "No blocks on message" };
  }

  const action = payload.actions?.find(
    (a) => a.action_id === CHECKLIST_CHECKBOX_ACTION_ID,
  );
  const selected = new Set(
    action?.selected_options?.map((o) => o.value) ?? [],
  );

  const newBlocks = applyChecklistSelectionToBlocks(blocks, selected);

  const updated = await slackApiForm(token, "chat.update", {
    channel,
    ts,
    blocks: JSON.stringify(newBlocks),
  });

  if (!updated.ok) {
    console.error("chat.update (checklist):", updated.error);
    return { error: updated.error ?? "chat.update failed" };
  }
  return {};
}
