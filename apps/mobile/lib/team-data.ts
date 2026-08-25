export const dealStages = ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const;
export type DealStage = (typeof dealStages)[number];

export type TeamContact = {
  name: string;
  phone: string;
  whatsapp: string;
};

export type TeamMessage = {
  id: string;
  body: string;
  senderRole: string;
  sentAt: string;
  readAt: string;
};

export type Deal = {
  id: string;
  outletId: string;
  customerName: string;
  title: string;
  stage: DealStage;
  amount: number | null;
  nextAction: string;
  followUpAt: string;
  notes: string;
  updatedAt: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, maximum = 2_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function dateText(value: unknown) {
  const result = text(value, 64);
  return result && Number.isFinite(new Date(result).valueOf()) ? result : "";
}

export function normalizeTeamContact(value: unknown): TeamContact | null {
  const item = record(value);
  if (!item) return null;
  const contact = {
    name: text(item.name, 160),
    phone: text(item.phone, 64),
    whatsapp: text(item.whatsapp, 128),
  };
  return contact.name || contact.phone || contact.whatsapp ? contact : null;
}

export function normalizeTeamMessages(value: unknown): TeamMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): TeamMessage[] => {
    const item = record(raw);
    if (!item) return [];
    const message = {
      id: text(item.id, 64),
      body: text(item.body, 2_000),
      senderRole: text(item.senderRole, 64),
      sentAt: dateText(item.sentAt),
      readAt: dateText(item.readAt),
    };
    return message.id && message.body && message.sentAt ? [message] : [];
  }).sort((a, b) => new Date(a.sentAt).valueOf() - new Date(b.sentAt).valueOf() || a.id.localeCompare(b.id));
}

export function normalizeDeals(value: unknown): Deal[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): Deal[] => {
    const item = record(raw);
    if (!item) return [];
    const amount = item.amount === null || item.amount === undefined || item.amount === ""
      ? null
      : Number(item.amount);
    const rawStage = text(item.stage, 64);
    const deal: Deal = {
      id: text(item.id, 64),
      outletId: text(item.outletId, 64),
      customerName: text(item.customerName, 200),
      title: text(item.title, 200),
      stage: isDealStage(rawStage) ? rawStage : "lead",
      amount: amount !== null && Number.isFinite(amount) ? Math.max(0, amount) : null,
      nextAction: text(item.nextAction, 500),
      followUpAt: dateText(item.followUpAt),
      notes: text(item.notes, 2_000),
      updatedAt: dateText(item.updatedAt),
    };
    return deal.id && deal.customerName && deal.title ? [deal] : [];
  }).sort((a, b) => {
    const followUpA = a.followUpAt ? new Date(a.followUpAt).valueOf() : Number.POSITIVE_INFINITY;
    const followUpB = b.followUpAt ? new Date(b.followUpAt).valueOf() : Number.POSITIVE_INFINITY;
    return followUpA - followUpB
      || new Date(b.updatedAt || 0).valueOf() - new Date(a.updatedAt || 0).valueOf()
      || a.id.localeCompare(b.id);
  });
}

export function teamContactUrl(kind: "phone" | "whatsapp", configuredValue: string) {
  const value = configuredValue.trim();
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (kind === "whatsapp") return `https://wa.me/${digits}`;
  const prefix = value.startsWith("+") ? "+" : "";
  return `tel:${prefix}${digits}`;
}

export function dealFollowUpStatus(
  followUpAt: string,
  stage: DealStage,
  nowMs = Date.now(),
): "Overdue" | "Due today" | "" {
  if (stage === "won" || stage === "lost") return "";
  const followUpMs = new Date(followUpAt).valueOf();
  if (!Number.isFinite(followUpMs) || !Number.isFinite(nowMs)) return "";
  const pakistanOffsetMs = 5 * 60 * 60 * 1_000;
  const followUpDay = Math.floor((followUpMs + pakistanOffsetMs) / 86_400_000);
  const today = Math.floor((nowMs + pakistanOffsetMs) / 86_400_000);
  if (followUpDay < today) return "Overdue";
  if (followUpDay === today) return "Due today";
  return "";
}

export function isDealStage(value: string): value is DealStage {
  return (dealStages as readonly string[]).includes(value);
}
