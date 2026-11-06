# Issue #280 Implementation Ledger

## Task 1: evaluator 消费记账机制
- [x] Write failing test
- [x] Run test to verify failure
- [x] Implement collectTerminalDecisions and markEmitted
- [x] Run test to verify pass
- [x] Commit

## Task 2: reporter 统一 drain 路径
- [x] Write failing test
- [x] Run test to verify failure
- [x] Implement #drainTerminalDecisions and #writtenFrames
- [x] Run test to verify pass
- [x] Commit

## Task 3: 覆盖所有取消路径
- [x] Write failing test
- [x] Run test to verify failure
- [x] Add drain calls to all cancellation paths
- [x] Run test to verify pass
- [x] Commit

## Task 4: onUnavailable 失效撤销
- [x] Write failing test
- [x] Run test to verify failure
- [x] Implement onUnavailable and shared helper
- [x] Run test to verify pass
- [x] Commit

## Task 5: A04/A05 集成测试
- [x] Write failing test
- [x] Run test to verify failure
- [x] Create child fixture and integration test
- [x] Run test to verify pass
- [x] Commit

## Task 6: 全套验收
- [x] Run targeted tests
- [x] Run npm run verify
- [x] Local CR
- [x] Final commit

## Rulings

(None yet)

## Notes

- Worktree: /home/elling/.pi/agent/worktrees/issue-280-frame-witness-delivery
- Spec: /home/elling/.github-issue-driven/zhuxixi/pi-agent-board/issue-280/spec.md (v3)
- Plan: docs/superpowers/plans/2026-11-06-issue-280-frame-witness-delivery.md
