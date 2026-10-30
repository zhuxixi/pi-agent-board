# Addendum to the converged signal contract — OSC 8 inside a frame vs after F

This addendum clarifies, but does not rewrite, `plans/issue-222-attach-ready-signal-implementation.md` (SHA256 `e773a0a9598758c5ef735edd7728049b943216fe51b6c60f5827c336aa4d1af3`). The original contract and its hash remain unchanged.

- The §5 exhaustive control list applies to the **post-F trailing window** where `proof.seq < snapshotSeq` may be accepted only for explicitly classified no-grid controls.
- OSC 8 hyperlink annotation **inside the current candidate frame** is content metadata, not a grid/cursor operation. It may be accepted only when complete and paired (BEL or ST), and can never create or complete a proof, count as parking/final visibility, or alter the text/link content.
- Any OSC 8 after CLOSE remains an invalidator under §5/FW-06 and cannot count as parking or preserve a proof. Unknown/malformed/unclosed forms fail closed.
- This clarification is based on actual Pi 1.4.0 output and was reviewed and accepted in `/home/elling/.pi/agent/agent-board/sessions/subagent-artifacts/outputs/issue-222-step23a-adapter-fix2-review.md`. It is not a general allowance for OSC 52, unknown DCS or other controls.

Parent decision record: `task-23a-osc8-decision.md` in SDD. Adapter acceptance: `task-23a-adapter-acceptance.md`.
