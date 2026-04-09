/** Slack이 같은 반응 이벤트를 두 번 보내거나 짧은 간격으로 재시도할 때 에피메럴 중복 전송 방지 */

const ID_TTL_MS = 3_600_000; // 1h
const BURST_TTL_MS = 45_000; // 같은 메시지에 같은 사람이 같은 반응 → 45초 안 1회만

type MapStore = Map<string, number>;

function getIdStore(): MapStore {
  const g = globalThis as typeof globalThis & {
    __slackJiraDedupeId?: MapStore;
  };
  if (!g.__slackJiraDedupeId) g.__slackJiraDedupeId = new Map();
  return g.__slackJiraDedupeId;
}

function getBurstStore(): MapStore {
  const g = globalThis as typeof globalThis & {
    __slackJiraDedupeBurst?: MapStore;
  };
  if (!g.__slackJiraDedupeBurst) g.__slackJiraDedupeBurst = new Map();
  return g.__slackJiraDedupeBurst;
}

function prune(store: MapStore, now: number, ttl: number) {
  for (const [k, t] of store) {
    if (now - t > ttl) store.delete(k);
  }
}

/**
 * @returns true → 이미 처리했거나 중복이므로 스킵(에피메럴 보내지 않음)
 */
export function shouldSkipDuplicateReactionInvite(args: {
  eventId?: string;
  teamId: string;
  channel: string;
  messageTs: string;
  userId: string;
  reaction: string;
}): boolean {
  const now = Date.now();
  const idStore = getIdStore();
  const burstStore = getBurstStore();
  prune(idStore, now, ID_TTL_MS);
  prune(burstStore, now, BURST_TTL_MS);

  const burstKey = `${args.teamId}:${args.channel}:${args.messageTs}:${args.userId}:${args.reaction}`;

  if (args.eventId && idStore.has(args.eventId)) {
    return true;
  }
  if (burstStore.has(burstKey)) {
    return true;
  }

  if (args.eventId) {
    idStore.set(args.eventId, now);
  }
  burstStore.set(burstKey, now);
  return false;
}
