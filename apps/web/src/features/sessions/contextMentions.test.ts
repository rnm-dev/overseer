import assert from "node:assert/strict";
import test from "node:test";
import { activeMentionQuery, insertMention, mentionForAtomicDeletion, mentionsRouteToPeople, remapMentions, removeMention, validComposerMentions } from "./contextMentions.js";

test("selected participants become structured tokens while raw at-text stays plain", () => {
  assert.deepEqual(activeMentionQuery("please ask @vik"), { startUtf16: 11, query: "vik" });
  const selected = insertMention("please ask @vik", activeMentionQuery("please ask @vik")!, { kind: "user", id: "u1", label: "Viktor" });
  assert.equal(selected.text, "please ask @Viktor ");
  assert.equal(validComposerMentions(selected.text, [selected.mention]).length, 1);
  assert.equal(validComposerMentions("please ask @Victor ", [selected.mention]).length, 0);
  assert.equal(activeMentionQuery("plain text"), null);
});

test("backspace and delete treat a selected person as one atomic token", () => {
  const selected = insertMention("hello @vik", activeMentionQuery("hello @vik")!, { kind: "user", id: "u1", label: "Viktor" });
  const mention = selected.mention;
  const endAfterSpace = mention.startUtf16 + mention.lengthUtf16 + 1;
  assert.equal(mentionForAtomicDeletion(selected.text, [mention], endAfterSpace, endAfterSpace, "Backspace"), mention);
  assert.equal(mentionForAtomicDeletion(selected.text, [mention], mention.startUtf16, mention.startUtf16, "Delete"), mention);
  assert.equal(mentionForAtomicDeletion(selected.text, [mention], mention.startUtf16, mention.startUtf16, "Backspace"), null);
});

test("only a structured person tag at the front selects the people route", () => {
  const front = insertMention("@vik", activeMentionQuery("@vik")!, { kind: "user", id: "u1", label: "Viktor" }).mention;
  assert.equal(mentionsRouteToPeople([front]), true);
  assert.equal(mentionsRouteToPeople([{ ...front, startUtf16: 6 }]), false);
  assert.equal(mentionsRouteToPeople([]), false);
});

test("removing a selected person removes its token and keeps later mention ranges aligned", () => {
  const viktor = insertMention("@vi", activeMentionQuery("@vi")!, { kind: "user", id: "u1", label: "Viktor" });
  const nova = insertMention(`${viktor.text}ask @no`, activeMentionQuery(`${viktor.text}ask @no`)!, { kind: "user", id: "u2", label: "Nova" });
  const removed = removeMention(nova.text, [viktor.mention, nova.mention], viktor.mention);
  assert.equal(removed.text, "ask @Nova ");
  assert.deepEqual(removed.mentions, [{ ...nova.mention, startUtf16: 4 }]);
});

test("editing text before a token keeps the selected person and its send lane", () => {
  const selected = insertMention("@vik", activeMentionQuery("@vik")!, { kind: "user", id: "u1", label: "Viktor" });
  assert.equal(mentionsRouteToPeople(selected.mentions), true);
  const typedAfter = remapMentions(selected.text, `${selected.text}please look`, selected.mentions);
  assert.deepEqual(typedAfter, selected.mentions);
  // The token itself moved right; it stays a mention, but no longer at offset 0.
  const typedBefore = remapMentions(selected.text, `hey ${selected.text}`, selected.mentions);
  assert.equal(typedBefore.length, 1);
  assert.equal(typedBefore[0]!.startUtf16, 4);
  assert.equal(mentionsRouteToPeople(typedBefore), false);
  // Typing inside the label is what demotes it back to plain text.
  assert.deepEqual(remapMentions(selected.text, "@Vikxtor ", selected.mentions), []);
});

test("a person can be added in the middle of an already written sentence", () => {
  const text = "ask  to look";
  const query = activeMentionQuery(`ask @vi to look`, 7);
  assert.deepEqual(query, { startUtf16: 4, query: "vi" });
  const selected = insertMention("ask @vi to look", query!, { kind: "user", id: "u1", label: "Viktor" });
  assert.equal(selected.text, "ask @Viktor to look");
  assert.equal(selected.mentions.length, 1);
  assert.equal(selected.mentions[0]!.startUtf16, 4);
  assert.equal(activeMentionQuery(text, 4), null);
});

test("inserting a person shifts the tokens that follow it", () => {
  const nova = insertMention("@no", activeMentionQuery("@no")!, { kind: "user", id: "u2", label: "Nova" });
  const withBoth = insertMention(`@vi ${nova.text}`, activeMentionQuery(`@vi ${nova.text}`, 3)!, { kind: "user", id: "u1", label: "Viktor" }, nova.mentions.map((mention) => ({ ...mention, startUtf16: mention.startUtf16 + 4 })));
  assert.equal(withBoth.text, "@Viktor @Nova ");
  assert.deepEqual(withBoth.mentions.map((mention) => [mention.startUtf16, mention.principal.id]), [[0, "u1"], [8, "u2"]]);
});
