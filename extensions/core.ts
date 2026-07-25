import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

export const DEFAULT_COPY_KEY: KeyId = "ctrl+shift+c";
export const DEFAULT_HIGHLIGHT_BORDER = true;

const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"] as const;
const MODIFIERS = new Set<string>(MODIFIER_ORDER);
const SPECIAL_KEYS = new Set([
	"escape",
	"enter",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	"f1",
	"f2",
	"f3",
	"f4",
	"f5",
	"f6",
	"f7",
	"f8",
	"f9",
	"f10",
	"f11",
	"f12",
]);
const SYMBOL_KEYS = new Set(["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "|", "~", "{", "}", ":", "<", ">", "?"]);
const RESERVED_KEYS = new Set(["escape", "shift+up", "shift+down"]);

export interface BrowseRepliesConfig {
	copyKey: KeyId;
	highlightBorder: boolean;
}

export interface ConfigResult {
	config: BrowseRepliesConfig;
	warning?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseKey(key: string): string {
	if (key === "esc") return "escape";
	if (key === "return") return "enter";
	return key;
}

function isBaseKey(key: string): boolean {
	return /^[a-z0-9]$/.test(key) || SPECIAL_KEYS.has(key) || SYMBOL_KEYS.has(key);
}

/** Validate and canonicalize the copy-key subset supported by this package. */
export function normalizeCopyKey(value: unknown): { key?: KeyId; error?: string } {
	if (typeof value !== "string" || !value.trim()) return { error: "copyKey must be a non-empty string" };

	const trimmed = value.trim().toLowerCase();
	// Pi documents "+" as a KeyId symbol, but its current runtime parser also
	// uses "+" as the modifier separator and cannot match "+" or "ctrl++".
	if (trimmed === "+" || trimmed.endsWith("++")) {
		return { error: "literal + is not supported by Pi's current key parser" };
	}
	const parts = trimmed.split("+");
	const rawBase = parts.pop();
	if (!rawBase) return { error: "copyKey has no base key" };
	const base = normalizeBaseKey(rawBase);
	if (!isBaseKey(base)) return { error: `unsupported base key ${JSON.stringify(rawBase)}` };

	const seen = new Set<string>();
	for (const modifier of parts) {
		if (!MODIFIERS.has(modifier)) return { error: `unsupported modifier ${JSON.stringify(modifier)}` };
		if (seen.has(modifier)) return { error: `duplicate modifier ${JSON.stringify(modifier)}` };
		seen.add(modifier);
	}

	const modifiers = MODIFIER_ORDER.filter((modifier) => seen.has(modifier));
	const normalized = [...modifiers, base].join("+");
	if (RESERVED_KEYS.has(normalized)) return { error: `${normalized} is reserved by reply browsing` };
	return { key: normalized as KeyId };
}

export function parseConfig(value: unknown): ConfigResult {
	const fallback = { config: { copyKey: DEFAULT_COPY_KEY, highlightBorder: DEFAULT_HIGHLIGHT_BORDER } };
	if (!isRecord(value)) return { ...fallback, warning: "configuration must be a JSON object" };

	const unknownKeys = Object.keys(value).filter((key) => key !== "copyKey" && key !== "highlightBorder");
	if (unknownKeys.length > 0) {
		return { ...fallback, warning: `unknown configuration field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}` };
	}

	const normalized = value.copyKey === undefined ? { key: DEFAULT_COPY_KEY } : normalizeCopyKey(value.copyKey);
	if (!normalized.key) return { ...fallback, warning: normalized.error ?? "invalid copyKey" };
	if (value.highlightBorder !== undefined && typeof value.highlightBorder !== "boolean") {
		return { ...fallback, warning: "highlightBorder must be a boolean" };
	}
	return {
		config: {
			copyKey: normalized.key,
			highlightBorder: value.highlightBorder ?? DEFAULT_HIGHLIGHT_BORDER,
		},
	};
}

export function parseConfigText(text: string): ConfigResult {
	try {
		return parseConfig(JSON.parse(text) as unknown);
	} catch (error) {
		return {
			config: { copyKey: DEFAULT_COPY_KEY, highlightBorder: DEFAULT_HIGHLIGHT_BORDER },
			warning: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export interface BorderColorTarget {
	borderColor?: (text: string) => string;
}

/**
 * Keep a dynamic border callback installed even when Pi copies its default
 * borderColor onto a custom editor after the editor factory returns.
 */
export function installDynamicBorderColor(
	editor: BorderColorTarget,
	isActive: () => boolean,
	activeColor: (text: string) => string,
): void {
	let normalBorderColor = editor.borderColor ?? ((text: string) => text);
	Object.defineProperty(editor, "borderColor", {
		configurable: true,
		enumerable: true,
		get: () => (isActive() ? activeColor : normalBorderColor),
		set: (value: (text: string) => string) => {
			normalBorderColor = value;
		},
	});
}

export type TerminalInputAction = "exit" | "block-enter" | "schedule-repair" | "passthrough";

export function decideTerminalInput(data: string, navigatorActive: boolean): TerminalInputAction {
	if (!navigatorActive) return "passthrough";
	if (matchesKey(data, "escape")) return "exit";
	if (matchesKey(data, "enter")) return "block-enter";
	if (matchesKey(data, "up") || matchesKey(data, "down")) return "schedule-repair";
	return "passthrough";
}

interface RepairScheduler {
	set(callback: () => void): unknown;
	clear(handle: unknown): void;
}

const defaultRepairScheduler: RepairScheduler = {
	set: (callback) => setTimeout(callback, 0),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Best-effort repair for Pi switching the editor into private prompt history. */
export class BoundaryRepairController {
	private pending: { handle: unknown; baseline: string; selectedIndex: number } | undefined;

	constructor(
		private readonly getText: () => string,
		private readonly setText: (text: string) => void,
		private readonly isActive: () => boolean,
		private readonly getSelectedIndex: () => number,
		private readonly scheduler: RepairScheduler = defaultRepairScheduler,
	) {}

	get hasPending(): boolean {
		return this.pending !== undefined;
	}

	/** Restore a prior corruption, if any, before the next input is processed. */
	beforeInput(): void {
		if (!this.pending) return;
		this.repairIfNeeded(this.pending);
		this.cancel();
	}

	schedule(): void {
		this.beforeInput();
		const repair = {
			handle: undefined as unknown,
			baseline: this.getText(),
			selectedIndex: this.getSelectedIndex(),
		};
		this.pending = repair;
		repair.handle = this.scheduler.set(() => {
			if (this.pending !== repair) return;
			this.repairIfNeeded(repair);
			this.pending = undefined;
		});
	}

	cancel(): void {
		if (!this.pending) return;
		this.scheduler.clear(this.pending.handle);
		this.pending = undefined;
	}

	private repairIfNeeded(repair: { baseline: string; selectedIndex: number }): void {
		if (!this.isActive() || this.getSelectedIndex() !== repair.selectedIndex) return;
		if (this.getText() !== repair.baseline) this.setText(repair.baseline);
	}
}

interface TextPart {
	type: string;
	text?: unknown;
}

interface MessageLike {
	role?: unknown;
	content?: unknown;
}

export interface SessionEntryLike {
	type?: unknown;
	message?: MessageLike;
}

/** Extract raw text from one message, matching Pi's adjacent-text concatenation. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as TextPart[])
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("");
}

/** Group all assistant text produced for one user turn into one browsable reply. */
export function extractReplies(entries: readonly SessionEntryLike[]): string[] {
	const replies: string[] = [];
	let segments: string[] = [];
	let haveUserTurn = false;

	const finish = () => {
		if (haveUserTurn && segments.length > 0) replies.push(segments.join("\n\n"));
		segments = [];
	};

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		if (entry.message.role === "user") {
			finish();
			haveUserTurn = true;
			continue;
		}
		if (entry.message.role !== "assistant" || !haveUserTurn) continue;
		const text = textOf(entry.message.content);
		if (text.trim()) segments.push(text);
	}
	finish();
	return replies;
}

export interface NavigationResult {
	text: string;
	selectionChanged: boolean;
	exited: boolean;
}

export class ReplyNavigator {
	private replies: string[] = [];
	private index = -1;
	private draft = "";

	get active(): boolean {
		return this.index !== -1;
	}

	get selectedIndex(): number {
		return this.index;
	}

	get total(): number {
		return this.replies.length;
	}

	enter(replies: readonly string[], draft: string): NavigationResult | undefined {
		if (replies.length === 0) return undefined;
		this.replies = [...replies];
		this.draft = draft;
		this.index = this.replies.length - 1;
		return { text: this.replies[this.index]!, selectionChanged: true, exited: false };
	}

	previous(currentText: string): NavigationResult | undefined {
		if (!this.active) return undefined;
		this.replies[this.index] = currentText;
		if (this.index === 0) return { text: currentText, selectionChanged: false, exited: false };
		this.index--;
		return { text: this.replies[this.index]!, selectionChanged: true, exited: false };
	}

	next(currentText: string): NavigationResult | undefined {
		if (!this.active) return undefined;
		this.replies[this.index] = currentText;
		if (this.index === this.replies.length - 1) {
			const draft = this.draft;
			this.reset();
			return { text: draft, selectionChanged: true, exited: true };
		}
		this.index++;
		return { text: this.replies[this.index]!, selectionChanged: true, exited: false };
	}

	exit(): string | undefined {
		if (!this.active) return undefined;
		const draft = this.draft;
		this.reset();
		return draft;
	}

	reset(): void {
		this.replies = [];
		this.index = -1;
		this.draft = "";
	}
}
