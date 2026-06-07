import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const ENABLE_FOCUS_EVENTS = "\x1b[?1004h";
const DISABLE_FOCUS_EVENTS = "\x1b[?1004l";
const DEFAULT_IDLE_MS = 3 * 60 * 1000;
const CUSTOM_TYPE = "pi-recap";
const SHOWN_ENTRY_TYPE = "pi-recap-shown";

type RecapState = {
	focused: boolean;
	lastCompletedTurnAt: number | undefined;
	shownThisSession: boolean;
	generating: boolean;
	pendingRecap: string | undefined;
	timer: NodeJS.Timeout | undefined;
	cleanupFocus: (() => void) | undefined;
};

type MessageEntryLike = {
	type: string;
	timestamp?: string;
	customType?: string;
	message?: {
		role?: string;
		content?: unknown;
		timestamp?: number;
	};
};

type TextBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
};

const getIdleMs = (): number => {
	const raw = process.env.PI_RECAP_IDLE_MS;
	if (!raw) return DEFAULT_IDLE_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_MS;
};

const state: RecapState = {
	focused: true,
	lastCompletedTurnAt: undefined,
	shownThisSession: false,
	generating: false,
	pendingRecap: undefined,
	timer: undefined,
	cleanupFocus: undefined,
};

function clearTimer() {
	if (state.timer) {
		clearTimeout(state.timer);
		state.timer = undefined;
	}
}

function timestampOf(entry: MessageEntryLike): number | undefined {
	if (typeof entry.message?.timestamp === "number") return entry.message.timestamp;
	if (entry.timestamp) {
		const parsed = Date.parse(entry.timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function getTurnStats(entries: readonly SessionEntry[]): { count: number; lastCompletedAt: number | undefined } {
	let count = 0;
	let sawUser = false;
	let lastCompletedAt: number | undefined;

	for (const raw of entries as readonly MessageEntryLike[]) {
		if (raw.type !== "message") continue;
		const role = raw.message?.role;
		if (role === "user") {
			sawUser = true;
			continue;
		}
		if (role === "assistant" && sawUser) {
			count += 1;
			lastCompletedAt = timestampOf(raw) ?? lastCompletedAt;
			sawUser = false;
		}
	}

	return { count, lastCompletedAt };
}

function hasShownEntry(entries: readonly SessionEntry[]): boolean {
	return (entries as readonly MessageEntryLike[]).some(
		(entry) => entry.type === "custom" && entry.customType === SHOWN_ENTRY_TYPE,
	);
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			const block = part as TextBlock;
			if (block?.type === "text" && typeof block.text === "string") return [block.text];
			if (block?.type === "toolCall" && typeof block.name === "string") {
				return [`[tool:${block.name} ${JSON.stringify(block.arguments ?? {})}]`];
			}
			return [];
		})
		.join("\n");
}

function buildRecapPrompt(entries: readonly SessionEntry[]): string {
	const lines: string[] = [];
	for (const raw of entries as readonly MessageEntryLike[]) {
		if (raw.type !== "message") continue;
		const role = raw.message?.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
		const text = extractText(raw.message?.content).trim();
		if (!text) continue;
		lines.push(`${role}: ${text}`);
	}

	return [
		"Write exactly one concise Pi recap line for a user returning to a coding session.",
		"Format exactly: ※ recap: <one sentence or two short sentences> (disable recaps in /settings)",
		"Include goal, current progress/status, important counts, running loops/jobs, and next action if known.",
		"Do not use markdown lists or headings. Be specific and compact.",
		"",
		"Conversation/session history:",
		lines.join("\n\n"),
	].join("\n");
}

async function generateRecap(ctx: ExtensionContext): Promise<string | undefined> {
	const fake = process.env.PI_RECAP_FAKE_RESPONSE;
	if (fake) return fake;

	const model = ctx.model;
	if (!model) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return undefined;

	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildRecapPrompt(ctx.sessionManager.getBranch()) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			reasoningEffort: "low",
		},
	);

	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();

	if (!text) return undefined;
	return text.startsWith("※ recap:") ? text : `※ recap: ${text} (disable recaps in /settings)`;
}

function shouldGenerateRecap(ctx: ExtensionContext, now = Date.now()): boolean {
	if (state.focused) return false;
	if (state.shownThisSession || state.pendingRecap || state.generating) return false;
	if (ctx.hasPendingMessages() || !ctx.isIdle()) return false;

	const stats = getTurnStats(ctx.sessionManager.getBranch());
	if (stats.count < 3) return false;

	const lastCompletedAt = state.lastCompletedTurnAt ?? stats.lastCompletedAt;
	if (!lastCompletedAt) return false;
	state.lastCompletedTurnAt = lastCompletedAt;

	return now - lastCompletedAt >= getIdleMs();
}

function showRecap(pi: ExtensionAPI, recap: string) {
	if (state.shownThisSession) return;
	state.pendingRecap = undefined;
	state.shownThisSession = true;
	pi.sendMessage({
		customType: CUSTOM_TYPE,
		content: recap,
		display: true,
		details: { shownAt: new Date().toISOString() },
	});
	pi.appendEntry(SHOWN_ENTRY_TYPE, { shownAt: new Date().toISOString() });
}

async function runIdleCheck(pi: ExtensionAPI, ctx: ExtensionContext) {
	state.timer = undefined;
	if (!shouldGenerateRecap(ctx)) return;

	state.generating = true;
	try {
		const recap = await generateRecap(ctx);
		if (!recap || state.shownThisSession) return;
		if (state.focused) {
			showRecap(pi, recap);
		} else {
			state.pendingRecap = recap;
		}
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(`pi-recap failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
	} finally {
		state.generating = false;
	}
}

function scheduleIdleCheck(pi: ExtensionAPI, ctx: ExtensionContext) {
	clearTimer();
	if (state.focused || state.shownThisSession || state.pendingRecap || state.generating) return;

	const stats = getTurnStats(ctx.sessionManager.getBranch());
	if (stats.count < 3) return;
	const lastCompletedAt = state.lastCompletedTurnAt ?? stats.lastCompletedAt;
	if (!lastCompletedAt) return;
	state.lastCompletedTurnAt = lastCompletedAt;

	const delay = Math.max(0, getIdleMs() - (Date.now() - lastCompletedAt));
	state.timer = setTimeout(() => void runIdleCheck(pi, ctx), delay);
	state.timer.unref?.();
}

function installFocusTracking(pi: ExtensionAPI, ctx: ExtensionContext): (() => void) | undefined {
	if (ctx.mode !== "tui") return undefined;
	process.stdout.write(ENABLE_FOCUS_EVENTS);

	const unsubscribe = ctx.ui.onTerminalInput((data) => {
		if (data === FOCUS_OUT) {
			state.focused = false;
			scheduleIdleCheck(pi, ctx);
			return { consume: true };
		}
		if (data === FOCUS_IN) {
			state.focused = true;
			clearTimer();
			if (state.pendingRecap) showRecap(pi, state.pendingRecap);
			return { consume: true };
		}
		return undefined;
	});

	return () => {
		unsubscribe();
		process.stdout.write(DISABLE_FOCUS_EVENTS);
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		clearTimer();
		state.focused = true;
		state.pendingRecap = undefined;
		state.generating = false;
		state.cleanupFocus?.();
		state.cleanupFocus = installFocusTracking(pi, ctx);

		const branch = ctx.sessionManager.getBranch();
		const stats = getTurnStats(branch);
		state.lastCompletedTurnAt = stats.lastCompletedAt;
		state.shownThisSession = hasShownEntry(ctx.sessionManager.getEntries());
	});

	pi.on("agent_end", async (_event, ctx) => {
		state.lastCompletedTurnAt = Date.now();
		state.pendingRecap = undefined;
		scheduleIdleCheck(pi, ctx);
	});

	pi.on("session_shutdown", async () => {
		clearTimer();
		state.cleanupFocus?.();
		state.cleanupFocus = undefined;
	});
}
