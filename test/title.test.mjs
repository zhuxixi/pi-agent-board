import assert from "node:assert/strict";
import { test } from "node:test";
import { isGreetingPrompt, normalizeGeneratedTitle, titlePrompt } from "../src/core/title.mjs";

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
