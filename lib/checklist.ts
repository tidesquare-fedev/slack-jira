import { slackApiForm } from "@/lib/jira-slack-helpers";

/** Slack checkboxes 요소당 최대 옵션 수 */
const MAX_ITEMS = 10;

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

/** `/check` 뒤 텍스트 → 항목 배열 (줄바꿈만 구분, 쉼표는 문장 안에 자유롭게 사용 가능) */
export function parseChecklistLines(text: string): string[] {
  const raw = text.trim();
  if (!raw) return [];

  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

/** 슬래시 커맨드 즉시 응답 JSON (본문만 JSON.stringify 해서 반환) */
export function buildChecklistSlashResponse(
  lines: string[],
  userId: string,
): Record<string, unknown> {
  const options = lines.map((line, i) => ({
    text: {
      type: "plain_text" as const,
      text: line.length > 75 ? `${line.slice(0, 72)}…` : line,
    },
    value: String(i),
  }));

  return {
    response_type: "in_channel",
    text: `체크리스트 (${lines.length}개 항목)`,
    blocks: [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<@${userId}>님이 만든 체크리스트`,
          },
        ],
      },
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
    ],
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
