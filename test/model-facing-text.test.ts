import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BOOT_TOOL_NAMES, NOTES_PROTOCOL_CLOSE_TAG, renderProtocolBlock } from "../src/boot/text.js";
import { CLAUDE_WARNING_PROMPT } from "../plugins/claude/src/text.js";
import { COMMAND_NOTICE, PI_PRE_RESET_HINTS, commandWarningContent, warningContent } from "../plugins/pi/text.js";
import { COUNTDOWN_LINE, FORCED_CONTINUATIONS, GUIDANCE_CLOSE_TAG, GUIDANCE_OPEN_TAG, NORMAL_CONTINUATIONS, WARNING_BODY, WARNING_CALL, WARNING_TIMING, selectContinuation, tokenBudgetGuidance } from "../src/budget/text.js";
test("early guidance binds the remaining room and the host's reset tool", () => {
	const guidance = tokenBudgetGuidance(1234, "forget_this");
	assert.ok(guidance.startsWith(`${GUIDANCE_OPEN_TAG}\n`));
	assert.ok(guidance.endsWith(`\n${GUIDANCE_CLOSE_TAG}`));
	assert.match(guidance, /\b1234\b/);
	assert.ok(guidance.includes("`forget_this`"));
	assert.equal(guidance.includes("empty_brain"), false, "the default tool name must not leak through substitution");
});

test("the countdown closes the second-tier notice only, in both hosts", () => {
	const pi = warningContent();
	assert.ok(pi.startsWith(`${GUIDANCE_OPEN_TAG}\n`));
	assert.ok(pi.endsWith(`\n${GUIDANCE_CLOSE_TAG}`));
	assert.equal(pi, `${GUIDANCE_OPEN_TAG}\n${WARNING_TIMING}\n${WARNING_BODY}\n${WARNING_CALL}\n${COUNTDOWN_LINE}\n${GUIDANCE_CLOSE_TAG}`);
	assert.equal(CLAUDE_WARNING_PROMPT, pi, "Pi and Claude receive identical copy");
	assert.equal(pi.split(COUNTDOWN_LINE).length - 1, 1, "the second tier carries the countdown exactly once");
	const prompted = commandWarningContent("/empty keep going");
	assert.equal(prompted, `${GUIDANCE_OPEN_TAG}\n${COMMAND_NOTICE.prompted}\n${WARNING_BODY}\n${WARNING_CALL}\n${COUNTDOWN_LINE}\n${GUIDANCE_CLOSE_TAG}\n/empty keep going`);
	assert.equal(commandWarningContent(), `${GUIDANCE_OPEN_TAG}\n${COMMAND_NOTICE.bare}\n${WARNING_BODY}\n${WARNING_CALL}\n${COUNTDOWN_LINE}\n${GUIDANCE_CLOSE_TAG}`);
	assert.ok(prompted.endsWith("\n/empty keep going"), "command text remains plain close-out context");
	assert.equal(prompted.includes(PI_PRE_RESET_HINTS), false, "manual commands own reset timing");
	assert.ok(CLAUDE_WARNING_PROMPT.endsWith(`\n${COUNTDOWN_LINE}\n${GUIDANCE_CLOSE_TAG}`));
	assert.equal(prompted.includes(WARNING_TIMING), false, "manual requests replace the budget opening");
	assert.equal(tokenBudgetGuidance(100, "empty_brain").includes(COUNTDOWN_LINE), false, "the first tier never counts down");
});

test("only Pi's protocol explains that reset erases the human's view", () => {
	const pi = renderProtocolBlock({ ...DEFAULT_BOOT_TOOL_NAMES, preResetHints: PI_PRE_RESET_HINTS });
	assert.ok(pi.includes(`\n${PI_PRE_RESET_HINTS}\n${NOTES_PROTOCOL_CLOSE_TAG}`), "both hints end the protocol, before the closing tag");
	assert.equal(pi.split(PI_PRE_RESET_HINTS).length - 1, 1, "the hints appear once");
	const renamed = renderProtocolBlock({ ...DEFAULT_BOOT_TOOL_NAMES, wipe: "forget_this", preResetHints: PI_PRE_RESET_HINTS });
	assert.ok(renamed.includes(PI_PRE_RESET_HINTS.replaceAll("empty_brain", "forget_this")), "the hint follows the host's wipe binding");
	assert.equal(renamed.includes("empty_brain"), false);
	for (const text of [renderProtocolBlock(DEFAULT_BOOT_TOOL_NAMES), renderProtocolBlock({ ...DEFAULT_BOOT_TOOL_NAMES, wipe: "mcp__notesoup__empty_brain" })]) {
		assert.equal(text.includes(PI_PRE_RESET_HINTS), false, "a host whose reset leaves the view intact stays silent");
	}
});

test("continuations draw a complete entry from the pool for their reset origin", () => {
	assert.ok(NORMAL_CONTINUATIONS.length > 0);
	assert.ok(FORCED_CONTINUATIONS.length > 0);
	const random = Math.random;
	try {
		Math.random = () => 0;
		assert.equal(selectContinuation("normal"), NORMAL_CONTINUATIONS[0]);
		assert.equal(selectContinuation("forced"), FORCED_CONTINUATIONS[0]);
		Math.random = () => 0.999999;
		assert.equal(selectContinuation("normal"), NORMAL_CONTINUATIONS.at(-1), "the last entry is reachable without leaving the pool");
		assert.equal(selectContinuation("forced"), FORCED_CONTINUATIONS.at(-1));
	} finally {
		Math.random = random;
	}
	for (const line of [...NORMAL_CONTINUATIONS, ...FORCED_CONTINUATIONS]) {
		assert.ok(line.length > 0);
		assert.equal(/[\r\n]/.test(line), false, "a pool entry is one complete paragraph");
		assert.equal(line.trim(), line, "no entry carries stray surrounding whitespace");
	}
});
