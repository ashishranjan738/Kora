# E2E Test Plan: Terminal Lifecycle & Notification Features

## Overview
This document outlines the end-to-end testing scenarios for terminal lifecycle fixes and notification features implemented in PR #107 (notification features) and this PR (terminal lifecycle fixes).

## Test Scope
- Terminal scroll position preservation
- Terminal fullscreen content preservation
- Message notification system (badges, toasts, previews)
- Multi-agent notification coordination

---

## Test Environment Setup

### Prerequisites
- Kora daemon running on port 7891 (dev mode)
- Clean browser session (clear cache/cookies)
- At least 2 agent terminals available in a session

### Test Data
- Create a multi-agent session with 3+ agents
- Ensure agents can send messages to each other
- Have terminals with existing output (scrollback buffer)

---

## Test Scenarios

### Scenario 1: Terminal Scroll Position Preservation

**Objective:** Verify terminal preserves scroll position when user has scrolled up to read history

**Steps:**
1. Open agent terminal with substantial output (50+ lines)
2. Scroll up to middle of terminal history
3. Wait for new output to arrive (or trigger command that produces output)
4. Observe scroll position

**Expected Result:**
- Scroll position remains fixed at middle of history
- New output does NOT auto-scroll terminal to bottom
- User can continue reading history without interruption

**Failure Indicators:**
- Terminal jumps to bottom when new output arrives
- User loses their place in history

---

### Scenario 2: Terminal Auto-Scroll When At Bottom

**Objective:** Verify terminal auto-scrolls when user is at bottom (default behavior)

**Steps:**
1. Open agent terminal
2. Ensure scrollbar is at bottom
3. Trigger command that produces output
4. Observe scroll behavior

**Expected Result:**
- Terminal auto-scrolls to show new output
- User sees new lines as they arrive

**Failure Indicators:**
- New output appears but terminal doesn't scroll
- User must manually scroll to see new output

---

### Scenario 3: Terminal Fullscreen Content Preservation

**Objective:** Verify terminal content is preserved when toggling fullscreen mode

**Steps:**
1. Open agent terminal in mosaic view
2. Type some commands and generate output
3. Note the terminal content and scroll position
4. Click fullscreen expand button
5. Verify content is identical
6. Exit fullscreen (ESC or click outside)
7. Verify content is still preserved

**Expected Result:**
- Terminal content identical in all views
- No loss of scrollback history
- No duplicate terminal instances created
- Scroll position maintained across transitions

**Failure Indicators:**
- Terminal content clears/resets when entering fullscreen
- Terminal shows duplicate/stale content
- Scroll position resets to top or bottom

---

### Scenario 4: Message Notification Badge Display

**Objective:** Verify unread message badge displays correctly

**Steps:**
1. Open terminal panel with multiple agent tabs
2. Switch to Agent A's tab
3. Have Agent B send a message (via send_message tool)
4. Observe Agent B's tab

**Expected Result:**
- Blue badge appears on Agent B's tab
- Badge shows "1"
- Badge tooltip shows "1 unread message"

**Additional Steps:**
5. Have Agent B send 4 more messages (total: 5 unread)
6. Observe badge updates to "5"
7. Have Agent B send 5 more messages (total: 10 unread)
8. Observe badge shows "9+"
9. Hover badge to see tooltip showing actual count "10 unread messages"

**Failure Indicators:**
- Badge doesn't appear
- Badge shows wrong count
- Badge shows number instead of "9+" for 10+ messages

---

### Scenario 5: Message Notification Toast

**Objective:** Verify toast notification appears with sender and preview

**Steps:**
1. Open terminal panel with Agent A active
2. Have Agent B send message: "Task completed successfully"
3. Observe toast notification

**Expected Result:**
- Toast appears in top-right of terminal panel
- Toast shows: "📩 New message from Backend in Backend"
- Toast shows preview: "Task completed successfully"
- Toast auto-dismisses after 4 seconds

**Additional Steps:**
4. Before auto-dismiss, click X button on toast
5. Verify toast dismisses immediately

**Failure Indicators:**
- Toast doesn't appear
- Toast shows "(no content)" instead of preview
- Toast doesn't auto-dismiss
- X button doesn't work

---

### Scenario 6: Toast Click-to-Focus

**Objective:** Verify clicking toast switches to the terminal

**Steps:**
1. Open terminal panel with Agent A active (and visible)
2. Have Agent B send a message
3. Observe toast appears for Agent B
4. Click on toast (not the X button)

**Expected Result:**
- Terminal panel switches to Agent B's tab
- Toast dismisses
- Agent B's unread badge clears

**Failure Indicators:**
- Click doesn't switch tabs
- Toast doesn't dismiss
- Badge remains after switching

---

### Scenario 7: Unread Count Management

**Objective:** Verify unread count increments and clears correctly

**Steps:**
1. Open terminal panel with Agent A active
2. Send 3 messages to Agent B (from another agent or manually)
3. Verify Agent B tab shows badge with "3"
4. Click on Agent B's tab
5. Observe badge

**Expected Result:**
- Badge shows "3" before switching
- Badge disappears immediately upon switching to Agent B
- No residual unread count

**Failure Indicators:**
- Badge count doesn't clear
- Badge count clears but reappears
- Badge shows wrong count

---

### Scenario 8: Multi-Agent Notification Coordination

**Objective:** Verify notifications work correctly with multiple agents

**Steps:**
1. Open terminal panel with 4 agent tabs (A, B, C, D)
2. Set Agent A as active
3. Send messages:
   - Agent B sends 2 messages
   - Agent C sends 5 messages
   - Agent D sends 12 messages
4. Observe all tabs

**Expected Result:**
- Agent B badge: "2"
- Agent C badge: "5"
- Agent D badge: "9+" (tooltip: "12 unread messages")
- Agent A: no badge (active tab)
- Toast shows only most recent message (from Agent D)

**Additional Steps:**
5. Click Agent B tab
6. Verify Agent B badge clears
7. Verify Agent C and D badges remain unchanged

**Failure Indicators:**
- Wrong badge counts
- Badges don't persist when switching tabs
- Toast shows wrong sender

---

### Scenario 9: Notification Preview Extraction

**Objective:** Verify message preview is correctly extracted from terminal output

**Test Cases:**

#### 9a. Quoted Preview
**Input:** `[Message from Backend]: "Deploy completed successfully"`

**Expected:** Preview shows "Deploy completed successfully"

#### 9b. Unquoted Long Text
**Input:** `[New message from Frontend]: Please review the changes when you have time`

**Expected:** Preview shows "Please review the changes when you have time"

#### 9c. No Preview (Short Text)
**Input:** `[Message from Worker]: \n`

**Expected:** No preview shown in toast (message and sender only)

#### 9d. Case Insensitive
**Input:** `[message from Architect]: "Test message"`

**Expected:** Detects pattern, shows sender "Architect", preview "Test message"

---

### Scenario 10: Mobile Responsive Notifications

**Objective:** Verify notifications display correctly on mobile screens

**Steps:**
1. Resize browser window to mobile width (< 768px)
2. Open terminal panel
3. Trigger a notification toast

**Expected Result:**
- Toast spans full width (left: 12px, right: 12px)
- Toast position adjusted (top: 48px)
- Text truncates properly
- X button remains accessible
- Badge remains visible and readable

**Failure Indicators:**
- Toast overflows screen
- Toast text unreadable
- Buttons too small to tap
- Badge overlaps tab text

---

## Regression Tests

### Terminal Registry Persistence
**Objective:** Ensure terminal instances are reused, not recreated

**Steps:**
1. Open Agent A terminal
2. Generate output
3. Navigate away from Multi-Agent View
4. Navigate back to Multi-Agent View
5. Check Agent A terminal

**Expected:** Same terminal content, no reset

---

### WebSocket Reconnection
**Objective:** Ensure notifications work after WebSocket reconnection

**Steps:**
1. Open agent terminal
2. Stop daemon (simulate disconnect)
3. Wait for WebSocket to close
4. Restart daemon
5. Wait for reconnection
6. Send message to agent

**Expected:** Toast and badge still work after reconnection

---

## Performance Tests

### Terminal Output Performance
**Objective:** Ensure scroll position check doesn't degrade performance

**Steps:**
1. Run command that produces rapid output (e.g., `cat large-file.txt`)
2. Scroll up while output is streaming
3. Observe scroll behavior and responsiveness

**Expected:**
- Scroll remains responsive
- No lag or stuttering
- Position stays fixed

---

### Multiple Notification Bursts
**Objective:** Ensure notification system handles rapid messages

**Steps:**
1. Have multiple agents send messages simultaneously
2. Observe badge updates and toast display

**Expected:**
- All badges update correctly
- Toast shows most recent message
- No UI freezing or crashes

---

## Success Criteria

### All Tests Pass When:
✅ Scroll position preserved when scrolled up
✅ Auto-scroll works when at bottom
✅ Fullscreen preserves terminal content
✅ Badges show correct counts (including "9+")
✅ Toasts show sender and preview
✅ Toast auto-dismiss and manual dismiss work
✅ Click-to-focus switches tabs correctly
✅ Unread counts increment and clear properly
✅ Multiple agents coordinate correctly
✅ Preview extraction handles all formats
✅ Mobile responsive layout works
✅ Terminal registry persists instances
✅ WebSocket reconnection preserves functionality
✅ Performance remains acceptable under load

---

## Known Limitations

1. **happy-dom Warning:** Test suite shows non-critical warning about `htmlElement.appendChild`. This is a known issue with happy-dom library and doesn't affect functionality.

2. **Toast Overlap:** If multiple messages arrive rapidly (< 4 seconds apart), only the most recent toast is shown. This is intentional to avoid UI clutter.

3. **Preview Extraction:** Only captures preview from the message chunk immediately following the notification header. If preview is delayed by multiple chunks, it won't be captured.

---

## Test Execution Checklist

- [ ] Run automated unit tests: `npm test` (56 tests should pass)
- [ ] Execute all manual E2E scenarios above
- [ ] Test on Chrome, Firefox, Safari
- [ ] Test on desktop (1920x1080)
- [ ] Test on tablet (768px width)
- [ ] Test on mobile (375px width)
- [ ] Test with light and dark themes
- [ ] Test with 2, 4, and 8 concurrent agents
- [ ] Test with high terminal output volume
- [ ] Test WebSocket disconnect/reconnect scenarios
- [ ] Verify no console errors during tests
- [ ] Verify no memory leaks over extended use

---

## Reporting Issues

When reporting test failures, include:
- Test scenario number and name
- Steps to reproduce
- Expected vs actual behavior
- Screenshots or video
- Browser and OS version
- Console errors (if any)
