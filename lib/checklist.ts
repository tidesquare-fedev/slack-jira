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

/**
 * 한 줄이 "멘션만"이면 체크 항목으로 넣지 않음.
 * - `<@U…>`만 있던 줄은 strip 후 빈 문자열로 이미 걸러짐.
 * - Slack UI 없이 적힌 `@rebecca` 같은 줄은 `<@…>`로 안 바뀌어도 할 일이 아님.
 */
function isMentionOnlyLine(line: string): boolean {
  const s = line.trim();
  if (!s) return true;
  const tokens = s.split(/\s+/);
  return tokens.every((t) => /^@[^\s@]+$/.test(t));
}

/**
 * 멘션만 적은 줄에서 `@표시용핸들` 토큰만 뽑음 (할 일 줄은 제외).
 * Slack이 `<@U…>`로 치환하지 않은 경우 알림용으로 users.lookupByUsername 시도할 때 사용.
 */
export function extractRawAtHandlesFromMentionOnlyLines(text: string): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!isMentionOnlyLine(trimmed)) continue;
    for (const t of trimmed.split(/\s+/)) {
      const h = t.startsWith("@") ? t.slice(1) : t;
      if (!h || seen.has(h)) continue;
      seen.add(h);
      ordered.push(h);
    }
  }
  return ordered;
}

function dedupeUserIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** @핸들 문자열을 workspace username으로 간주해 user id로 치환 (실패한 핸들은 별도 반환) */
export async function resolveSlackAtHandlesToUserIds(
  token: string,
  handles: string[],
): Promise<{ ids: string[]; unresolvedHandles: string[] }> {
  const ids: string[] = [];
  const unresolvedHandles: string[] = [];
  const seen = new Set<string>();

  for (const raw of handles) {
    const handle = raw.replace(/^@+/, "").trim();
    if (!handle) continue;

    const candidates = Array.from(
      new Set([handle, handle.toLowerCase()]),
    ).filter(Boolean);

    let id: string | undefined;
    for (const username of candidates) {
      const r = await slackApiForm<{ user?: { id?: string } }>(
        token,
        "users.lookupByUsername",
        { username },
      );
      if (r.ok && r.user?.id) {
        id = r.user.id;
        break;
      }
    }

    if (id) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    } else {
      unresolvedHandles.push(handle);
    }
  }

  return { ids, unresolvedHandles };
}

/** `<@U…>`로 잡힌 ID + lookup으로 잡힌 ID 합치기 */
export function mergeSlackNotifyUserIds(
  fromTokens: string[],
  fromResolvedHandles: string[],
): string[] {
  return dedupeUserIds([...fromTokens, ...fromResolvedHandles]);
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
    .filter((l) => !isMentionOnlyLine(l))
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
  unresolvedAtHandles: string[] = [],
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
          text: `<@${userId}>님이 /check로 등록한 체크리스트`,
        },
      ],
    },
  ];

  const pingMrkdwnParts = mentionUserIds.map((id) => `<@${id}>`);
  for (const h of unresolvedAtHandles) {
    if (h) pingMrkdwnParts.push(`@${h}`);
  }

  if (pingMrkdwnParts.length > 0) {
    const mentionText = pingMrkdwnParts.join(" ");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `확인 부탁드려요: ${mentionText}`,
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
    pingMrkdwnParts.length > 0 ? ` · 알림·태그 ${pingMrkdwnParts.length}건` : "";

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
