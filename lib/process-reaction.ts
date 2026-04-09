import {
  createJiraIssue,
  fetchMessage,
  getPermalink,
  jiraAddIssuesToSprint,
  jiraListActiveAndFutureSprints,
  jiraParseCreateIssueErrorForSlack,
  jiraResolveAssigneeAccountId,
  normalizeJiraHost,
  plainToJiraAdf,
  postThreadReply,
  slackApiForm,
  slackApiJson,
  summaryFromMessage,
} from "@/lib/jira-slack-helpers";

const OPEN_JIRA_MODAL_ACTION = "open_jira_modal";
const DECLINE_JIRA_INVITE_ACTION = "decline_jira_invite";
const JIRA_MODAL_CALLBACK_ID = "jira_ticket_modal_submit";

/** 반응 당사자에게만 보이는 안내 + 모달 열기 버튼 (reaction_added에서는 모달을 직접 열 수 없음) */
export async function sendJiraFormInvite(input: {
  channel: string;
  messageTs: string;
  reactorUserId: string;
}): Promise<void> {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken || !input.reactorUserId) {
    console.error("sendJiraFormInvite: missing token or user");
    return;
  }

  const value = JSON.stringify({
    c: input.channel,
    t: input.messageTs,
    u: input.reactorUserId,
  });

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "이 메시지로 *Jira 티켓*을 만들 수 있습니다.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "티켓 만들기",
          },
          style: "primary",
          action_id: OPEN_JIRA_MODAL_ACTION,
          value,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "거절" },
          action_id: DECLINE_JIRA_INVITE_ACTION,
        },
      ],
    },
  ];

  const posted = await slackApiForm(slackToken, "chat.postEphemeral", {
    channel: input.channel,
    user: input.reactorUserId,
    text: "이 메시지로 Jira 티켓을 만들 수 있습니다.",
    blocks: JSON.stringify(blocks),
  });

  if (!posted.ok) {
    console.error("chat.postEphemeral:", posted.error);
  }
}

type BlockActionPayload = {
  type: "block_actions";
  trigger_id: string;
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string };
  actions?: { action_id: string; value?: string }[];
};

export async function handleDeclineJiraInvite(
  payload: BlockActionPayload,
): Promise<{ error?: string }> {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) return { error: "Bot token missing" };

  const channel = payload.channel?.id;
  const ts = payload.message?.ts;
  if (!channel || !ts) {
    console.error("decline_jira_invite: missing channel or message.ts");
    return { error: "Missing message context" };
  }

  const deleted = await slackApiForm(slackToken, "chat.delete", {
    channel,
    ts,
  });

  if (!deleted.ok) {
    console.error("chat.delete (ephemeral dismiss):", deleted.error);
    return { error: deleted.error ?? "chat.delete failed" };
  }
  return {};
}

/** block_actions: 모달 열기 또는 거절(안내 메시지 삭제) */
export async function handleBlockActions(
  payload: BlockActionPayload,
): Promise<{ error?: string }> {
  const actionId = payload.actions?.find(
    (a) =>
      a.action_id === DECLINE_JIRA_INVITE_ACTION ||
      a.action_id === OPEN_JIRA_MODAL_ACTION,
  )?.action_id;
  if (actionId === DECLINE_JIRA_INVITE_ACTION) {
    return handleDeclineJiraInvite(payload);
  }
  if (actionId === OPEN_JIRA_MODAL_ACTION) {
    return handleBlockActionOpenModal(payload);
  }
  return {};
}

type ViewSubmissionPayload = {
  type: "view_submission";
  user?: { id?: string };
  view: {
    id: string;
    callback_id: string;
    private_metadata: string;
    state: {
      values: Record<
        string,
        Record<string, { value?: string; selected_option?: { value: string } }>
      >;
    };
  };
};

function parseMeta(raw: string): {
  channel: string;
  messageTs: string;
  reactorUserId: string;
} | null {
  try {
    const v = JSON.parse(raw) as {
      c?: string;
      t?: string;
      u?: string;
    };
    if (v.c && v.t) {
      return { channel: v.c, messageTs: v.t, reactorUserId: v.u ?? "" };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function handleBlockActionOpenModal(
  payload: BlockActionPayload,
): Promise<{ error?: string }> {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) return { error: "Bot token missing" };

  const action = payload.actions?.find(
    (a) => a.action_id === OPEN_JIRA_MODAL_ACTION,
  );
  if (!action?.value) return { error: "No action" };

  let channel: string;
  let messageTs: string;
  let reactorUserId: string;
  try {
    const j = JSON.parse(action.value) as { c: string; t: string; u?: string };
    channel = j.c;
    messageTs = j.t;
    reactorUserId = j.u ?? "";
  } catch {
    return { error: "Bad button value" };
  }

  let msg;
  try {
    msg = await fetchMessage(slackToken, channel, messageTs);
  } catch (e) {
    console.error("fetchMessage in modal:", e);
    return {
      error:
        "메시지를 불러오지 못했습니다. 봇이 채널·스레드에 접근 가능한지(channels:history) 확인하세요.",
    };
  }

  const rawText = msg.text?.trim() ?? "";
  const permalink = await getPermalink(slackToken, channel, messageTs);
  const meta = JSON.stringify({ c: channel, t: messageTs, u: reactorUserId });

  const initialSummary = summaryFromMessage(
    rawText || permalink || "Slack",
  ).slice(0, 3000);

  /** 티켓 본문(Jira description) 기본값 = 반응이 달린 메시지 원문 */
  const initialBody = (
    rawText ||
    "(메시지 텍스트가 없습니다. 블록·첨부만 있는 경우 수동으로 적어 주세요.)"
  ).slice(0, 3000);

  const jiraHost = normalizeJiraHost(process.env.JIRA_HOST);
  const jiraEmail = process.env.JIRA_EMAIL;
  const jiraToken = process.env.JIRA_API_TOKEN;
  const projectKey = process.env.JIRA_PROJECT_KEY;
  const boardRaw = process.env.JIRA_BOARD_ID?.trim();

  const noneSprint = {
    text: { type: "plain_text" as const, text: "— 스프린트 미지정 —" },
    value: "_none_",
  };
  let sprintOptions: { text: { type: "plain_text"; text: string }; value: string }[] =
    [noneSprint];

  if (boardRaw && jiraHost && jiraEmail && jiraToken && projectKey) {
    const boardId = Number.parseInt(boardRaw, 10);
    if (!Number.isNaN(boardId)) {
      try {
        const sprints = await jiraListActiveAndFutureSprints({
          host: jiraHost,
          email: jiraEmail,
          apiToken: jiraToken,
          boardId,
        });
        for (const s of sprints.slice(0, 90)) {
          const prefix = s.state === "active" ? "[진행] " : "";
          const label = `${prefix}${s.name}`.slice(0, 75);
          sprintOptions.push({
            text: { type: "plain_text", text: label },
            value: String(s.id),
          });
        }
      } catch (e) {
        console.error("jiraListActiveAndFutureSprints:", e);
      }
    }
  }

  const view = {
    type: "modal",
    callback_id: JIRA_MODAL_CALLBACK_ID,
    private_metadata: meta,
    title: { type: "plain_text", text: "Jira 티켓" },
    submit: { type: "plain_text", text: "생성" },
    close: { type: "plain_text", text: "취소" },
    blocks: [
      {
        type: "input",
        block_id: "summary_block",
        label: { type: "plain_text", text: "요약 (제목)" },
        element: {
          type: "plain_text_input",
          action_id: "summary",
          initial_value: initialSummary,
          max_length: 3000,
        },
      },
      {
        type: "input",
        block_id: "desc_block",
        optional: false,
        label: {
          type: "plain_text",
          text: "본문 (Slack 메시지 원문)",
        },
        element: {
          type: "plain_text_input",
          action_id: "description",
          multiline: true,
          initial_value: initialBody,
          max_length: 3000,
        },
      },
      {
        type: "input",
        block_id: "assignee_block",
        optional: true,
        label: {
          type: "plain_text",
          text: "담당자 (이메일·표시 이름·accountId, 비우면 미배정)",
        },
        element: {
          type: "plain_text_input",
          action_id: "assignee_query",
          placeholder: {
            type: "plain_text",
            text: "예: hong@company.com 또는 Jira accountId",
          },
          max_length: 200,
        },
      },
      {
        type: "input",
        block_id: "sprint_block",
        optional: true,
        label: { type: "plain_text", text: "스프린트" },
        element: {
          type: "static_select",
          action_id: "sprint_pick",
          placeholder: { type: "plain_text", text: "스프린트 선택" },
          options: sprintOptions,
          initial_option: noneSprint,
        },
      },
    ],
  };

  const opened = await slackApiJson(slackToken, "views.open", {
    trigger_id: payload.trigger_id,
    view,
  });

  if (!opened.ok) {
    console.error("views.open:", opened.error);
    return { error: opened.error ?? "views.open failed" };
  }
  return {};
}

export async function handleViewSubmissionJira(
  payload: ViewSubmissionPayload,
): Promise<{ responseBody: object }> {
  if (payload.view.callback_id !== JIRA_MODAL_CALLBACK_ID) {
    return { responseBody: { response_action: "clear" } };
  }

  const meta = parseMeta(payload.view.private_metadata);
  if (!meta) {
    return {
      responseBody: {
        response_action: "errors",
        errors: { summary_block: "내부 오류: 컨텍스트가 없습니다." },
      },
    };
  }

  const summary =
    payload.view.state.values.summary_block?.summary?.value?.trim() ?? "";
  const description =
    payload.view.state.values.desc_block?.description?.value?.trim() ?? "";
  const assigneeQuery =
    payload.view.state.values.assignee_block?.assignee_query?.value?.trim() ??
    "";
  const sprintRaw =
    payload.view.state.values.sprint_block?.sprint_pick?.selected_option
      ?.value ?? "_none_";

  if (!summary) {
    return {
      responseBody: {
        response_action: "errors",
        errors: { summary_block: "요약을 입력해 주세요." },
      },
    };
  }

  if (!description) {
    return {
      responseBody: {
        response_action: "errors",
        errors: { desc_block: "본문을 입력해 주세요. (기본값은 Slack 메시지 원문입니다.)" },
      },
    };
  }

  const slackToken = process.env.SLACK_BOT_TOKEN;
  const jiraHost = normalizeJiraHost(process.env.JIRA_HOST);
  const jiraEmail = process.env.JIRA_EMAIL;
  const jiraToken = process.env.JIRA_API_TOKEN;
  const projectKey = process.env.JIRA_PROJECT_KEY;
  const issueType = process.env.JIRA_ISSUE_TYPE || "Task";
  const browseBase =
    process.env.JIRA_BROWSE_URL ||
    (jiraHost ? `https://${jiraHost}/browse` : "");

  if (!slackToken || !jiraHost || !jiraEmail || !jiraToken || !projectKey) {
    return {
      responseBody: {
        response_action: "errors",
        errors: {
          summary_block: "서버 설정(Jira/Slack 환경변수)이 없습니다.",
        },
      },
    };
  }

  let assigneeAccountId: string | null = null;
  if (assigneeQuery) {
    try {
      const resolved = await jiraResolveAssigneeAccountId({
        host: jiraHost,
        email: jiraEmail,
        apiToken: jiraToken,
        projectKey,
        query: assigneeQuery,
      });
      if (!resolved) {
        return {
          responseBody: {
            response_action: "errors",
            errors: {
              assignee_block:
                "담당자를 찾지 못했습니다. 이메일·이름(일부)·Jira accountId를 확인하세요.",
            },
          },
        };
      }
      assigneeAccountId = resolved.accountId;
    } catch (e) {
      const msgText = e instanceof Error ? e.message : String(e);
      return {
        responseBody: {
          response_action: "errors",
          errors: {
            assignee_block:
              msgText.length > 120
                ? `${msgText.slice(0, 117)}…`
                : msgText,
          },
        },
      };
    }
  }

  let sprintIdNum: number | null = null;
  if (sprintRaw && sprintRaw !== "_none_") {
    const n = Number.parseInt(sprintRaw, 10);
    if (Number.isNaN(n)) {
      return {
        responseBody: {
          response_action: "errors",
          errors: {
            sprint_block: "스프린트 선택이 올바르지 않습니다.",
          },
        },
      };
    }
    sprintIdNum = n;
  }

  let msg;
  try {
    msg = await fetchMessage(slackToken, meta.channel, meta.messageTs);
  } catch {
    /* thread_ts 폴백용 */
  }

  const permalink = await getPermalink(
    slackToken,
    meta.channel,
    meta.messageTs,
  ).catch(() => null);

  const footer = [
    "---",
    "출처: Slack (`jira_add` 반응 → 모달에서 생성)",
    permalink ? `링크: ${permalink}` : null,
    meta.reactorUserId ? `작성: <@${meta.reactorUserId}>` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const jiraDescriptionText = `${description}\n\n${footer}`;

  let issue: { key: string };
  try {
    issue = await createJiraIssue({
      host: jiraHost,
      email: jiraEmail,
      apiToken: jiraToken,
      projectKey,
      issueType,
      summary,
      descriptionAdf: plainToJiraAdf(jiraDescriptionText),
      assigneeAccountId,
    });
  } catch (e) {
    const msgText = e instanceof Error ? e.message : String(e);
    const mapped = jiraParseCreateIssueErrorForSlack(msgText);
    const block = mapped?.block ?? "summary_block";
    const text =
      mapped?.text ??
      (msgText.length > 140 ? `${msgText.slice(0, 137)}...` : msgText);
    return {
      responseBody: {
        response_action: "errors",
        errors: { [block]: text },
      },
    };
  }

  let sprintWarning = "";
  if (sprintIdNum !== null) {
    try {
      await jiraAddIssuesToSprint({
        host: jiraHost,
        email: jiraEmail,
        apiToken: jiraToken,
        sprintId: sprintIdNum,
        issueKeys: [issue.key],
      });
    } catch (e) {
      console.error("jiraAddIssuesToSprint:", e);
      sprintWarning =
        "\n(스프린트에 자동 반영되지 않았습니다. Jira 보드에서 스프린트를 확인해 주세요.)";
    }
  }

  const issueUrl =
    browseBase && issue.key ? `${browseBase}/${issue.key}` : issue.key;

  const threadRoot = msg ? msg.thread_ts ?? msg.ts : meta.messageTs;
  await postThreadReply(
    slackToken,
    meta.channel,
    threadRoot,
    `티켓 생성이 완료 되었습니다.\n${issueUrl}${sprintWarning}`,
  );

  return { responseBody: { response_action: "clear" } };
}

/** @deprecated — 자동 생성 대신 sendJiraFormInvite 사용 */
export async function processJiraAddReaction(input: {
  channel: string;
  messageTs: string;
  reactorUserId: string;
}): Promise<void> {
  return sendJiraFormInvite(input);
}
