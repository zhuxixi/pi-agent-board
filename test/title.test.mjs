import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TITLE_MODEL, DEFAULT_TITLE_THINKING_LEVEL, isGreetingPrompt, normalizeGeneratedTitle, resolveTitleSettings, titlePrompt } from "../src/core/title.mjs";

test("titlePrompt asks for a 3-4 word plain-text title", () => {
	const prompt = titlePrompt("fix websocket reconnect bug");
	assert.match(prompt, /3 or 4 words max/i);
	assert.match(prompt, /plain text only/i);
	assert.match(prompt, /fix websocket reconnect bug/i);
});

test("normalizeGeneratedTitle strips wrappers and limits to four words", () => {
	assert.equal(normalizeGeneratedTitle('"Fix Websocket Reconnect Flow Now"', "fallback"), "Fix Websocket Reconnect Flow");
});

test("normalizeGeneratedTitle falls back when blank", () => {
	assert.equal(normalizeGeneratedTitle("   ", "fallback-name"), "fallback-name");
});

test("isGreetingPrompt matches pure greetings", () => {
	const en = ["hello", "Hello!", "HI", "hey", "hiya", "yo", "sup", "howdy", "greetings", "morning",
		"good morning", "Good Morning!", "good afternoon", "good evening", "good day"];
	const zh = ["你好", "您好", "嗨", "哈喽", "哈啰", "在吗", "在么", "早上好", "上午好", "早安", "下午好", "晚上好", "晚安"];
	const variants = ["hello hello", "嗨嗨", "hi there", "你好呀", " hello? ", "hello!!!", "hello,hello", "hi呀"];
	for (const s of [...en, ...zh, ...variants]) assert.equal(isGreetingPrompt(s), true, s);
});

test("isGreetingPrompt rejects non-greetings", () => {
	const cases = ["hello, please fix X", "helloX", "你好请修复", "there", "呀", "there hello",
		"good", "fix the bug", "", " ", "hi, what is the cache hit rate for redis"];
	for (const s of cases) assert.equal(isGreetingPrompt(s), false, JSON.stringify(s));
});

test("resolveTitleSettings keeps env precedence and off semantics", () => {
	assert.deepEqual(resolveTitleSettings({}, null), { enabled: true, model: DEFAULT_TITLE_MODEL, thinking: DEFAULT_TITLE_THINKING_LEVEL });
	assert.equal(resolveTitleSettings({ AGENT_BOARD_TITLE_MODEL: "off" }, "x/y").enabled, false);
	assert.equal(resolveTitleSettings({ AGENT_VIEW_TITLE_MODEL: "off" }, null).enabled, false);
	assert.deepEqual(resolveTitleSettings({ AGENT_BOARD_TITLE_MODEL: "a/b", AGENT_VIEW_TITLE_MODEL: "c/d" }, null).model, "a/b");
	assert.deepEqual(resolveTitleSettings({ AGENT_VIEW_TITLE_MODEL: "c/d" }, null).model, "c/d");
	assert.deepEqual(resolveTitleSettings({ AGENT_VIEW_TITLE_MODEL: "c/d" }, "cfg/m").model, "cfg/m");
	assert.deepEqual(resolveTitleSettings({}, null).thinking, DEFAULT_TITLE_THINKING_LEVEL);
	assert.deepEqual(resolveTitleSettings({ AGENT_BOARD_TITLE_THINKING_LEVEL: "high" }, null).thinking, "high");
	assert.deepEqual(resolveTitleSettings({ AGENT_VIEW_TITLE_THINKING_LEVEL: "low" }, null).thinking, "low");
	assert.deepEqual(resolveTitleSettings({ AGENT_BOARD_TITLE_THINKING_LEVEL: "high", AGENT_VIEW_TITLE_THINKING_LEVEL: "low" }, null).thinking, "high");
	assert.deepEqual(resolveTitleSettings({ AGENT_BOARD_TITLE_THINKING_LEVEL: "off" }, null).thinking, "off");
});
