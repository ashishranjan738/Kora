# Upstream Holdpty Contribution Plan

**Status:** 🟢 Ready for Upstream Discussion
**Timeline:** 10-15 days (both features + integration)
**Risk:** Low (additive changes, no breaking changes)

---

## Executive Summary

We're proposing **two features** to the [holdpty](https://github.com/marcfargas/holdpty) project to improve automation and UI integration:

1. **`--cols/--rows` flags** — Set terminal dimensions at launch (eliminates resize flashing)
2. **`holdpty send` command** — Inject input programmatically (enables automation)

Both features:
- ✅ Align with holdpty's minimal, no-daemon philosophy
- ✅ Have clear precedent in tmux/screen
- ✅ Include comprehensive design docs + tests
- ✅ Are purely additive (zero breaking changes)
- ✅ Solve real Kora use cases

---

## Feature Quick Reference

### Feature 1: --cols/--rows Flags

**Current Problem:**
```typescript
// Launch with defaults → immediate resize (causes flashing)
await holdpty.launch("--bg", "--name", "agent", "--", "zsh");
await holdpty.resize("agent", 80, 25);  // Visible reflow
```

**With Feature:**
```typescript
// Launch with target dimensions (no flashing)
await holdpty.launch("--bg", "--name", "agent", "--cols", "80", "--rows", "25", "--", "zsh");
```

**Implementation:** ~50 LOC, 2-3 hours
**Risk:** Very Low

### Feature 2: send Command

**Current Problem:**
```typescript
// Must implement manual socket protocol (80 LOC)
async sendKeys(session: string, keys: string): Promise<void> {
  const socket = net.createConnection(socketPath);
  // ... 80 lines of protocol handling ...
}
```

**With Feature:**
```bash
holdpty send session-name "npm test\n"
```

**Implementation:** ~150 LOC, 4-6 hours
**Risk:** Low-Medium (exclusive attach limitation documented)

---

## Documentation

All design documents published as GitHub Gists:

| Document | Purpose | Link |
|----------|---------|------|
| **--cols/--rows Design** | Full implementation plan for terminal dimensions | [View Gist](https://gist.github.com/ashishranjan738/9b5e492eaa1766e2ce6359b608122eec) |
| **send Command Design** | Complete design for input injection | [View Gist](https://gist.github.com/ashishranjan738/96f8b528e18a522dd5d2ee2bb2ab2c39) |
| **Upstream Summary** | Feature comparison & roadmap | [View Gist](https://gist.github.com/ashishranjan738/498009efd1b98d907aedc1b62f9d2d87) |
| **Repository Analysis** | Repo audit & risk assessment | [View Gist](https://gist.github.com/ashishranjan738/4b7a1288ce12a3a9c7b12e0a57855425) |

Each document includes:
- Motivation & use cases
- CLI interface design
- Line-by-line implementation plan
- Test strategy (unit + integration + E2E)
- Risk assessment
- Backward compatibility analysis

---

## Upstream Discussion Issue

**Status:** ✅ Draft Complete

**Title:** Feature request: --cols/--rows flags + send command for automation

**Location:** `HOLDPTY_DISCUSSION_ISSUE_DRAFT.md` (in researcher worktree)

**Key Points:**
- Introduces Kora and use case
- Links all 4 gists
- Shows comparison to tmux/screen
- Asks 4 specific questions for feedback
- Emphasizes commitment to implement + maintain

**Ready to post:** Awaiting user approval

---

## Implementation Roadmap

### Phase 1: Upstream Discussion (1-2 weeks)
- [ ] Post discussion issue to holdpty repo
- [ ] Gauge maintainer (@marcfargas) interest
- [ ] Address design feedback
- [ ] Get green light to proceed

### Phase 2: Feature 1 - --cols/--rows (3-5 days)
- [ ] Fork holdpty repo
- [ ] Create branch: `feature/launch-cols-rows-flags`
- [ ] Implement CLI parsing + Holder integration
- [ ] Write comprehensive tests (unit + integration)
- [ ] Update documentation (README, usage string)
- [ ] Submit PR #1
- [ ] Address review feedback
- [ ] Merge ✅

### Phase 3: Feature 2 - send Command (4-6 days)
- [ ] Create branch: `feature/send-command`
- [ ] Implement `cmdSend()` + `send()` client function
- [ ] Add escape sequence parsing
- [ ] Write comprehensive tests (unit + integration + E2E)
- [ ] Document limitations (exclusive attach conflict)
- [ ] Update documentation
- [ ] Submit PR #2
- [ ] Address review feedback
- [ ] Merge ✅

### Phase 4: Kora Integration (2-3 days)
- [ ] Wait for holdpty release (v0.3.1 or v0.3.2)
- [ ] Update Kora's `package.json`: `holdpty@^0.3.1`
- [ ] Update `holdpty-controller.ts` to use new flags
- [ ] Optionally refactor sendKeys to use `send` command
- [ ] Test in Kora dev environment (port 7891)
- [ ] Submit Kora PR
- [ ] Merge ✅

**Total Timeline:** 10-15 days (depends on maintainer responsiveness)

---

## Technical Challenges Identified

### Challenge 1: Exclusive Attach Conflict (send command)

**Issue:** Current holder only allows ONE "attach" mode connection at a time.

**Impact:** `holdpty send` will fail if a dashboard terminal is attached.

**Mitigation:**
- Document limitation clearly in README + error message
- Kora already routes through PtyManager when dashboard is open (no CLI needed)
- Error message guides users: "Cannot send: session has active terminal"

**Alternative:** Extend protocol with "send" mode (future enhancement, out of scope)

### Challenge 2: Windows Compatibility

**Issue:** ConPTY behavior may differ from Linux/macOS.

**Mitigation:**
- holdpty already has Windows support via CI
- Both features use existing PTY layer (no new platform code)
- Test locally on Windows before submitting PRs

### Challenge 3: Maintainer Responsiveness

**Issue:** Solo maintainer, unknown response time, no external PRs yet.

**Mitigation:**
- Strong justification in discussion issue
- Patient follow-up (ping after 1 week, 2 weeks)
- Fallback: Fork as `@kora/holdpty` if no response after 1 month

---

## Risk Assessment

| Risk Factor | Likelihood | Impact | Mitigation |
|-------------|------------|--------|------------|
| Maintainer rejects features | Low | High | Strong justification, quality impl |
| Long review cycle | Medium | Low | Polite follow-up, offer to iterate |
| Breaking Windows | Low | Medium | CI tests on Windows |
| Exclusive attach conflict | High | Medium | Document limitation, PtyManager workaround |
| Project abandoned | Very Low | High | Recent activity, can fork if needed |

**Overall Risk:** 🟢 Low (high confidence in acceptance)

---

## Success Metrics

### Technical Success
- ✅ Both PRs merged to upstream
- ✅ Test coverage >90% for new code
- ✅ CI passes on all platforms (Linux, macOS, Windows)
- ✅ No regressions in existing functionality
- ✅ Included in next minor release (v0.3.1/v0.3.2)

### Kora Success
- ✅ Terminal flashing eliminated (--cols/--rows)
- ✅ sendKeys simplified by 80 LOC (send command)
- ✅ No regressions in agent control
- ✅ Faster session initialization (<50ms improvement)

### Community Success
- ✅ Positive maintainer feedback
- ✅ Other users find features useful (GitHub reactions)
- ✅ No support burden (comprehensive docs)

---

## Fallback Plan

### If Upstream Rejects or Unresponsive (>1 month)

**Option A: Maintain Kora Fork** (Preferred)
- Fork holdpty → `@kora/holdpty`
- Apply patches locally
- Publish to npm as scoped package
- Document fork rationale in README

**Option B: External Wrapper**
- Keep upstream holdpty
- Build `kora-holdpty-cli` wrapper scripts
- Implement features as shell scripts around holdpty
- Less elegant, but avoids fork maintenance

**Option C: Revert to tmux**
- TmuxController already exists in Kora
- Trade-off: heavier dependency, more complex
- Only if holdpty integration proves untenable

**Preference:** Push for upstream acceptance with quality implementation.

---

## Why These Features Should Be Accepted

### 1. Aligns with holdpty Philosophy
- ✅ Minimal, composable commands
- ✅ No daemon, no config files
- ✅ Cross-platform support
- ✅ Simple CLI interface

### 2. Common Use Cases
- UI integration (dashboards, IDEs)
- Automation (CI/CD, testing)
- Agent orchestration systems
- Precedent: tmux users transitioning to holdpty

### 3. Low Maintenance Burden
- Zero new dependencies
- Additive changes only (no breaking changes)
- Comprehensive tests included
- Well-documented (README + inline comments)
- Commit to maintain features

### 4. Fills Feature Gap
Brings holdpty to **feature parity** with tmux/screen for basic automation:

| Feature | tmux | screen | holdpty (current) | holdpty (with PRs) |
|---------|------|--------|-------------------|-------------------|
| Terminal size at launch | ✅ | ✅ | ❌ | ✅ |
| Send input | ✅ `send-keys` | ✅ `-X stuff` | ❌ | ✅ |
| No daemon | ❌ | ❌ | ✅ | ✅ |
| Cross-platform | ⚠️ | ❌ | ✅ | ✅ |

---

## Next Steps (Prioritized)

### Immediate (This Week)
1. **User reviews discussion issue draft**
2. **If approved:** Post to holdpty repo (create issue)
3. **Monitor:** Wait for maintainer (@marcfargas) response

### Short-term (1-2 Weeks)
4. **If positive response:** Fork holdpty repo
5. **Implement Feature 1:** --cols/--rows flags
6. **Submit PR #1** with comprehensive tests
7. **Address review feedback**

### Medium-term (2-3 Weeks)
8. **Wait for PR #1 merge**
9. **Implement Feature 2:** send command
10. **Submit PR #2** with comprehensive tests
11. **Address review feedback**

### Long-term (3-4 Weeks)
12. **Wait for holdpty release** (v0.3.1 or v0.3.2)
13. **Update Kora integration**
14. **Test in dev environment** (port 7891)
15. **Merge Kora PR**

---

## Communication Strategy

### Initial Outreach (Discussion Issue)
- Introduce Kora and use case
- Show comparison to tmux/screen
- Link comprehensive design docs (gists)
- Ask for feedback before implementing
- Emphasize commitment to maintain

### Follow-up Strategy
- **Week 1:** Wait patiently for response
- **Week 2:** Polite ping if no response
- **Week 3:** Second follow-up
- **Week 4:** Offer to schedule call/discuss alternatives
- **Month 2+:** Consider fork option

### Tone
- **Respectful:** Acknowledge minimal design philosophy
- **Pragmatic:** Show real use cases
- **Collaborative:** Offer to iterate on design
- **Grateful:** Thank for building holdpty

---

## Resources

### Kora Integration Points
- **File:** `packages/daemon/src/core/holdpty-controller.ts`
- **newSession()** — Will use --cols/--rows flags
- **sendKeys()** — Can optionally migrate to `send` command
- **resize()** — Keep for dynamic resizing (still needed)

### Upstream Repository
- **GitHub:** https://github.com/marcfargas/holdpty
- **npm:** https://www.npmjs.com/package/holdpty
- **Maintainer:** Marc Fargas (@marcfargas)
- **Current Version:** v0.3.0
- **Recent Activity:** Feb 2026 (active development)

### Related Documentation
- holdpty README: https://github.com/marcfargas/holdpty#readme
- Kora holdpty controller: `packages/daemon/src/core/holdpty-controller.ts`
- Kora project context: `CLAUDE_CONTEXT.md`

---

## Status Summary

| Item | Status |
|------|--------|
| Research | ✅ Complete |
| Design Docs | ✅ Complete (4 gists published) |
| Discussion Issue Draft | ✅ Complete (awaiting user approval) |
| Maintainer Outreach | ⏸️ Pending (awaiting user approval) |
| Implementation | ⏸️ Blocked (awaiting maintainer green light) |
| Kora Integration | ⏸️ Blocked (awaiting upstream release) |

**Current Blocker:** User approval to post discussion issue to upstream

**Confidence Level:** 🟢 High (strong justification, clear use cases, low risk)

---

**Last Updated:** 2026-03-19
**Prepared By:** Researcher Agent
**Contact:** Architect for questions or changes
