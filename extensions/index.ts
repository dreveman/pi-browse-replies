import {
	copyToClipboard,
	CustomEditor,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BoundaryRepairController,
	decideTerminalInput,
	DEFAULT_COPY_KEY,
	DEFAULT_HIGHLIGHT_BORDER,
	extractReplies,
	installDynamicBorderColor,
	parseConfigText,
	ReplyNavigator,
	type ConfigResult,
} from "./core.ts";

const CONFIG_PATH = join(getAgentDir(), "pi-browse-replies.json");
const WIDGET_ID = "pi-browse-replies";

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function loadConfig(): ConfigResult {
	try {
		const result = parseConfigText(readFileSync(CONFIG_PATH, "utf8"));
		return result.warning ? { ...result, warning: `${CONFIG_PATH}: ${result.warning}; using defaults` } : result;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return { config: { copyKey: DEFAULT_COPY_KEY, highlightBorder: DEFAULT_HIGHLIGHT_BORDER } };
		}
		return {
			config: { copyKey: DEFAULT_COPY_KEY, highlightBorder: DEFAULT_HIGHLIGHT_BORDER },
			warning: `Could not read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}; using defaults`,
		};
	}
}

export default function (pi: ExtensionAPI) {
	const loadedConfig = loadConfig();
	const copyKey: KeyId = loadedConfig.config.copyKey;
	const highlightBorder = loadedConfig.config.highlightBorder;
	let configWarning = loadedConfig.warning;
	const navigator = new ReplyNavigator();
	let releaseTerminalInput: (() => void) | undefined;
	let boundaryRepair: BoundaryRepairController | undefined;

	const updateWidget = (ctx: ExtensionContext) => {
		if (!navigator.active) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_ID, [
			`Reply ${navigator.selectedIndex + 1}/${navigator.total} (shift+up/down to browse, ${copyKey} to copy)`,
		]);
	};

	const leaveBrowsing = (ctx: ExtensionContext, restoreDraft: boolean) => {
		boundaryRepair?.cancel();
		if (restoreDraft) {
			const draft = navigator.exit();
			if (draft !== undefined) ctx.ui.setEditorText(draft);
		} else {
			navigator.reset();
		}
		updateWidget(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		leaveBrowsing(ctx, false);

		if (highlightBorder) {
			// Replacing the editor solely for border styling can affect editor-specific
			// settings. Users can set highlightBorder:false to skip this entirely.
			const previousEditorFactory = ctx.ui.getEditorComponent();
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				const editor = previousEditorFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
				try {
					installDynamicBorderColor(
						editor,
						() => navigator.active,
						(text) => ctx.ui.theme.fg("borderAccent", text),
					);
				} catch (error) {
					ctx.ui.notify(
						`Could not install reply-mode border color: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
				return editor;
			});
		}

		if (configWarning) {
			ctx.ui.notify(configWarning, "warning");
			configWarning = undefined;
		}

		releaseTerminalInput?.();
		boundaryRepair = new BoundaryRepairController(
			() => ctx.ui.getEditorText(),
			(text) => ctx.ui.setEditorText(text),
			() => navigator.active,
			() => navigator.selectedIndex,
		);
		releaseTerminalInput = ctx.ui.onTerminalInput((data) => {
			// Flush a prior arrow repair before this input reaches the editor. This
			// prevents rapid typing, paste, or repeated arrows from being overwritten.
			boundaryRepair?.beforeInput();
			switch (decideTerminalInput(data, navigator.active)) {
				case "exit":
					leaveBrowsing(ctx, true);
					return { consume: true };
				case "block-enter":
					ctx.ui.notify("Exit reply browsing before submitting", "info");
					return { consume: true };
				case "schedule-repair":
					boundaryRepair?.schedule();
					return undefined;
				case "passthrough":
					return undefined;
			}
		});
	});

	pi.on("session_shutdown", () => {
		boundaryRepair?.cancel();
		boundaryRepair = undefined;
		releaseTerminalInput?.();
		releaseTerminalInput = undefined;
	});

	pi.on("before_agent_start", (_event, ctx) => {
		leaveBrowsing(ctx, false);
	});

	pi.registerShortcut("shift+up", {
		description: "Browse the previous complete assistant reply",
		handler: async (ctx) => {
			boundaryRepair?.cancel();
			if (!navigator.active) {
				const result = navigator.enter(extractReplies(ctx.sessionManager.getBranch()), ctx.ui.getEditorText());
				if (!result) {
					ctx.ui.notify("No previous replies yet", "info");
					return;
				}
				ctx.ui.setEditorText(result.text);
				updateWidget(ctx);
				return;
			}

			const result = navigator.previous(ctx.ui.getEditorText());
			if (result?.selectionChanged) ctx.ui.setEditorText(result.text);
			updateWidget(ctx);
		},
	});

	pi.registerShortcut("shift+down", {
		description: "Browse the next complete assistant reply and restore the draft after the newest",
		handler: async (ctx) => {
			boundaryRepair?.cancel();
			const result = navigator.next(ctx.ui.getEditorText());
			if (!result) return;
			if (result.selectionChanged) ctx.ui.setEditorText(result.text);
			updateWidget(ctx);
		},
	});

	pi.registerShortcut(copyKey, {
		description: "Copy current editor text",
		handler: async (ctx) => {
			const text = ctx.ui.getEditorText();
			if (!text.trim()) {
				ctx.ui.notify("Editor is empty — nothing to copy", "error");
				return;
			}
			try {
				await copyToClipboard(text);
				ctx.ui.notify(`Copied ${Buffer.byteLength(text, "utf8")} bytes`, "info");
			} catch (error) {
				ctx.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
