import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	BoundaryRepairController,
	decideTerminalInput,
	DEFAULT_COPY_KEY,
	DEFAULT_HIGHLIGHT_BORDER,
	extractReplies,
	installDynamicBorderColor,
	normalizeCopyKey,
	parseConfig,
	parseConfigText,
	ReplyNavigator,
	textOf,
} from "../extensions/core.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`ok - ${name}`);
	} catch (error) {
		console.error(`not ok - ${name}`);
		process.exitCode = 1;
		throw error;
	}
}

test("config defaults when copyKey is omitted", () => {
	assert.deepEqual(parseConfig({}), {
		config: { copyKey: DEFAULT_COPY_KEY, highlightBorder: DEFAULT_HIGHLIGHT_BORDER },
	});
});

test("config accepts and normalizes valid keys", () => {
	assert.equal(normalizeCopyKey(" ALT+C ").key, "alt+c");
	assert.equal(normalizeCopyKey("F12").key, "f12");
	assert.equal(normalizeCopyKey("SHIFT+CTRL+C").key, "ctrl+shift+c");
});

test("config rejects invalid values and syntax", () => {
	assert.ok(parseConfig(null).warning);
	assert.ok(parseConfig({ copyKey: 42 }).warning);
	assert.ok(parseConfig({ copyKey: "" }).warning);
	assert.ok(parseConfig({ copyKey: "ctrl+shift+zz" }).warning);
	assert.ok(parseConfig({ copyKey: "hyper+c" }).warning);
	assert.ok(parseConfig({ copyKey: "ctrl+ctrl+c" }).warning);
	assert.ok(parseConfig({ copyKey: "alt+c", typo: true }).warning);
	assert.ok(parseConfig({ highlightBorder: "yes" }).warning);
	assert.ok(parseConfigText("{").warning);
});

test("config rejects reply-navigation keys and unsupported literal plus", () => {
	assert.ok(parseConfig({ copyKey: "shift+up" }).warning);
	assert.ok(parseConfig({ copyKey: "shift+down" }).warning);
	assert.ok(parseConfig({ copyKey: "escape" }).warning);
	assert.ok(parseConfig({ copyKey: "esc" }).warning);
	assert.match(normalizeCopyKey("+").error ?? "", /not supported/);
	assert.match(normalizeCopyKey("ctrl++").error ?? "", /not supported/);
});

test("config accepts the border highlight opt-out", () => {
	assert.deepEqual(parseConfig({ copyKey: "alt+c", highlightBorder: false }), {
		config: { copyKey: "alt+c", highlightBorder: false },
	});
});

test("text extraction joins adjacent text parts and ignores non-text parts", () => {
	assert.equal(
		textOf([
			{ type: "text", text: "hello " },
			{ type: "thinking", thinking: "secret" },
			{ type: "text", text: "world" },
		]),
		"hello world",
	);
});

test("assistant messages in one user turn form one complete reply", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "question" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "I will inspect." }] } },
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Final answer." }] } },
		{ type: "message", message: { role: "user", content: "next question" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "only thinking" }] } },
	];
	assert.deepEqual(extractReplies(entries), ["I will inspect.\n\nFinal answer."]);
});

test("reply extraction handles multiple completed user turns", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", content: "orphan" } },
		{ type: "message", message: { role: "user", content: "one" } },
		{ type: "message", message: { role: "assistant", content: "first" } },
		{ type: "message", message: { role: "user", content: "two" } },
		{ type: "message", message: { role: "assistant", content: "second" } },
	];
	assert.deepEqual(extractReplies(entries), ["first", "second"]);
});

test("navigator selects newest and restores draft past newest", () => {
	const nav = new ReplyNavigator();
	assert.equal(nav.enter(["first", "second"], "draft")?.text, "second");
	assert.equal(nav.previous("edited second")?.text, "first");
	assert.equal(nav.next("edited first")?.text, "edited second");
	const result = nav.next("edited second again");
	assert.deepEqual(result, { text: "draft", selectionChanged: true, exited: true });
	assert.equal(nav.active, false);
});

test("navigator preserves edits and oldest boundary is a no-op", () => {
	const nav = new ReplyNavigator();
	nav.enter(["first", "second"], "draft");
	nav.previous("second edited");
	assert.deepEqual(nav.previous("first edited"), {
		text: "first edited",
		selectionChanged: false,
		exited: false,
	});
	assert.equal(nav.next("first edited again")?.text, "second edited");
});

test("navigator exit returns the original draft and reset clears state", () => {
	const nav = new ReplyNavigator();
	nav.enter(["reply"], "draft");
	assert.equal(nav.exit(), "draft");
	assert.equal(nav.active, false);
	assert.equal(nav.exit(), undefined);
	nav.enter(["reply"], "new draft");
	nav.reset();
	assert.equal(nav.active, false);
});

test("terminal input decisions scope Escape, Enter, and arrow repair to reply mode", () => {
	assert.equal(decideTerminalInput("\x1b", false), "passthrough");
	assert.equal(decideTerminalInput("\x1b", true), "exit");
	assert.equal(decideTerminalInput("\r", true), "block-enter");
	assert.equal(decideTerminalInput("\x1b[A", true), "schedule-repair");
	assert.equal(decideTerminalInput("x", true), "passthrough");
});

test("dynamic border preserves normal assignments and toggles active color", () => {
	let active = false;
	const editor = { borderColor: (text: string) => `normal:${text}` };
	installDynamicBorderColor(editor, () => active, (text) => `active:${text}`);
	assert.equal(editor.borderColor?.("line"), "normal:line");
	active = true;
	assert.equal(editor.borderColor?.("line"), "active:line");
	editor.borderColor = (text) => `new-normal:${text}`;
	assert.equal(editor.borderColor?.("line"), "active:line");
	active = false;
	assert.equal(editor.borderColor?.("line"), "new-normal:line");
});

test("boundary repair restores corruption before subsequent input", () => {
	let text = "reply";
	let active = true;
	let index = 2;
	let nextHandle = 0;
	const callbacks = new Map<number, () => void>();
	const scheduler = {
		set(callback: () => void): unknown {
			const handle = ++nextHandle;
			callbacks.set(handle, callback);
			return handle;
		},
		clear(handle: unknown): void {
			callbacks.delete(handle as number);
		},
	};
	const repair = new BoundaryRepairController(
		() => text,
		(value) => {
			text = value;
		},
		() => active,
		() => index,
		scheduler,
	);

	repair.schedule();
	text = "prompt history";
	repair.beforeInput();
	assert.equal(text, "reply");
	assert.equal(repair.hasPending, false);
	text += " edited";
	assert.equal(text, "reply edited");

	repair.schedule();
	text = "prompt history again";
	repair.beforeInput();
	repair.schedule();
	assert.equal(text, "reply edited");
	const callback = callbacks.values().next().value as (() => void) | undefined;
	callback?.();
	assert.equal(repair.hasPending, false);

	repair.schedule();
	index = 3;
	text = "new reply";
	for (const pending of callbacks.values()) pending();
	assert.equal(text, "new reply");
	active = false;
	repair.cancel();
});

console.log(`${passed} tests passed`);

export default function (_pi: ExtensionAPI): void {}
