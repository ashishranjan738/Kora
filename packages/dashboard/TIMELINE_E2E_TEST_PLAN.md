# Timeline Feature - E2E Test Plan

**Date:** 2026-03-19
**Feature:** Timeline with pagination, filters, and 15 event types
**Branch:** `feature/npm-packaging`
**Commit:** `e132638`

---

## Overview

This document outlines end-to-end testing scenarios for the timeline feature implementation, covering:
- Pagination with scroll-based loading
- Filter combinations (category, agents, search)
- All 15 event types rendering
- Live mode with polling
- Density modes (compact, normal, detailed)

---

## Test Environment Setup

### Prerequisites
- Kora daemon running on port 7891 (dev mode)
- Active session with multiple agents
- Events database populated with diverse event types
- Browser with developer tools open

### Test Data Requirements
- At least 100+ events in the database
- Mix of all 15 event types
- Events from 3+ different agents
- Events spanning multiple days

---

## Test Scenarios

### Scenario 1: Initial Page Load

**Objective:** Verify timeline loads with correct initial state

**Steps:**
1. Navigate to Multi-Agent View
2. Click on "Timeline" tab
3. Observe initial load

**Expected Results:**
- ✅ Loading indicator shows initially
- ✅ First 50 events load
- ✅ Events sorted by timestamp (newest first)
- ✅ Date dividers show ("Today", "Yesterday", dates)
- ✅ Event count badge shows correct number
- ✅ Default filters: "All" category, "Normal" density
- ✅ Live mode enabled by default

**Failure Indicators:**
- Infinite loading spinner
- No events displayed
- Events in wrong order
- Missing date dividers

---

### Scenario 2: Pagination - Scroll Loading

**Objective:** Verify pagination loads more events on scroll

**Steps:**
1. Load timeline (should have 100+ events total)
2. Scroll down to within 300px of bottom
3. Observe loading behavior
4. Continue scrolling to load more

**Expected Results:**
- ✅ "Loading more events..." indicator appears
- ✅ Next 50 events append to list
- ✅ No duplicate events
- ✅ Scroll position maintained
- ✅ Date dividers update correctly
- ✅ When < 50 events returned, "No more events to load" shows

**Failure Indicators:**
- No new events load on scroll
- Duplicate events appear
- Scroll jumps to top
- Infinite loading loop

---

### Scenario 3: Category Filters

**Objective:** Verify category filters work correctly

**Steps:**
1. Load timeline
2. Click "Agents" category filter
3. Verify only agent events show
4. Click "Messages" filter
5. Click "Tasks" filter
6. Click "System" filter
7. Click "All" to reset

**Expected Results:**

**Agents Filter:**
- ✅ Shows: agent-spawned, agent-removed, agent-crashed, agent-restarted, agent-status-changed
- ✅ Hides: all other event types
- ✅ Event count updates

**Messages Filter:**
- ✅ Shows: message-sent, message-received
- ✅ Hides: all other event types

**Tasks Filter:**
- ✅ Shows: task-created, task-updated, task-deleted
- ✅ Hides: all other event types

**System Filter:**
- ✅ Shows: session-created, session-paused, session-resumed, session-stopped, user-interaction, cost-threshold-reached
- ✅ Hides: all other event types

**All Filter:**
- ✅ Shows all event types

**Failure Indicators:**
- Wrong events visible
- Event count incorrect
- Filter doesn't apply

---

### Scenario 4: Agent Filter (MultiSelect)

**Objective:** Verify multiple agent selection works

**Steps:**
1. Load timeline
2. Open agent dropdown
3. Select "Frontend" agent
4. Verify only Frontend events show
5. Select "Backend" agent (in addition to Frontend)
6. Verify both agents' events show
7. Clear all selections

**Expected Results:**
- ✅ Single agent: Shows only that agent's events
- ✅ Multiple agents: Shows events from any selected agent
- ✅ Events where agent is sender or receiver both show
- ✅ Clear button removes all filters
- ✅ Dropdown shows selected agents as tags

**Failure Indicators:**
- Can't select multiple agents
- Wrong agents' events shown
- Clear doesn't work

---

### Scenario 5: Search Filter with Debounce

**Objective:** Verify search filters events and debounces input

**Steps:**
1. Load timeline
2. Type "task" in search box (slowly, character by character)
3. Observe filter updates
4. Clear search
5. Type "spawned" rapidly
6. Observe debounce behavior

**Expected Results:**
- ✅ Search updates after 300ms pause in typing
- ✅ Finds events by type name (e.g., "task-created")
- ✅ Finds events by agent name
- ✅ Finds events by content (message text, task title)
- ✅ Case-insensitive matching
- ✅ No filter updates while typing rapidly (debounced)
- ✅ Event count updates to match filtered results

**Failure Indicators:**
- Filter updates on every keystroke (no debounce)
- Search doesn't find matching events
- Search case-sensitive
- Lag or stuttering during typing

---

### Scenario 6: Combined Filters

**Objective:** Verify multiple filters work together

**Steps:**
1. Set category to "Agents"
2. Select specific agent "Frontend"
3. Type "spawned" in search
4. Verify results

**Expected Results:**
- ✅ Shows only: agent-spawned events from Frontend agent
- ✅ All three filters apply simultaneously
- ✅ Event count reflects combined filters
- ✅ Clearing one filter updates results correctly

**Failure Indicators:**
- Filters conflict or override each other
- Wrong events shown
- Can't combine filters

---

### Scenario 7: Density Modes

**Objective:** Verify all density modes display correctly

**Steps:**
1. Load timeline with message events
2. Set density to "Compact"
3. Observe event display
4. Set density to "Normal"
5. Set density to "Detailed"

**Expected Results:**

**Compact Mode:**
- ✅ One-line events
- ✅ No message content visible
- ✅ Time + agent + event type only
- ✅ More events fit on screen

**Normal Mode:**
- ✅ Two-line events
- ✅ Message preview visible (truncated)
- ✅ Event subtitles show
- ✅ "Show more" button for long messages

**Detailed Mode:**
- ✅ Full event data visible
- ✅ Complete message text
- ✅ All event metadata
- ✅ No truncation

**Failure Indicators:**
- Modes look identical
- Content doesn't change between modes
- Layout breaks

---

### Scenario 8: Event Type Rendering (All 15 Types)

**Objective:** Verify all event types render correctly

**Test Cases:**

#### 8a. Agent Events (5 types)
1. **agent-spawned**: Shows agent name, role badge, provider/model, "Terminal" button
2. **agent-removed**: Shows agent name, reason
3. **agent-crashed**: Shows agent name, exit code, "Restart" button, crash alert box
4. **agent-restarted**: Shows agent name
5. **agent-status-changed**: Shows "Agent → newStatus"

#### 8b. Message Events (2 types)
1. **message-sent**: Shows "From → To", message type badge, content preview
2. **message-received**: Shows "From → To", message type badge, content preview

#### 8c. Task Events (3 types)
1. **task-created**: Shows task title, "Task Board" button
2. **task-updated**: Shows task title, status badge, "Task Board" button
3. **task-deleted**: Shows task title

#### 8d. Session Events (4 types)
1. **session-created**: Shows session name
2. **session-paused**: Shows "Session paused"
3. **session-resumed**: Shows "Session resumed"
4. **session-stopped**: Shows "Session stopped"

#### 8e. System Events (2 types)
1. **user-interaction**: Shows "User → Agent", message content
2. **cost-threshold-reached**: Shows "Cost alert: $X.XX"

**Expected Results:**
- ✅ Each event type has appropriate:
  - Color-coded bullet (green/blue/red/yellow/purple/gray)
  - Event type badge
  - Formatted title
  - Relevant action buttons
- ✅ Time displayed in "h:mm AM/PM" format
- ✅ Tooltip shows full timestamp on hover

**Failure Indicators:**
- Event types missing
- Wrong colors
- No action buttons
- Layout broken

---

### Scenario 9: Live Mode

**Objective:** Verify live mode polls for new events

**Steps:**
1. Load timeline with live mode ON
2. Open terminal in another tab/window
3. Trigger new events (spawn agent, send message, create task)
4. Return to timeline
5. Wait 3-5 seconds
6. Toggle live mode OFF
7. Wait 15+ seconds

**Expected Results:**

**Live Mode ON:**
- ✅ Green "live" indicator dot visible
- ✅ New events appear within 3 seconds
- ✅ "X new events - click to scroll up" banner appears (if scrolled down)
- ✅ Auto-scroll to top if already at top
- ✅ Event count updates

**Live Mode OFF:**
- ✅ No live indicator
- ✅ Polling slows to 15 seconds
- ✅ Events still update, but slower
- ✅ Can manually refresh

**Failure Indicators:**
- Live mode doesn't poll
- New events never appear
- Banner doesn't show
- Polling interval wrong

---

### Scenario 10: Action Buttons

**Objective:** Verify action buttons work

**Steps:**
1. Find agent-spawned event
2. Click "Terminal" button
3. Verify terminal opens/focuses
4. Find agent-crashed event
5. Click "Restart" button
6. Verify restart triggered
7. Find task-created event
8. Click "Task Board" button
9. Verify task board opens

**Expected Results:**
- ✅ Terminal button opens agent terminal panel
- ✅ Restart button restarts crashed agent
- ✅ Task Board button navigates to task board
- ✅ Buttons only show for relevant event types

**Failure Indicators:**
- Buttons don't respond
- Wrong action triggered
- Buttons show on wrong events

---

### Scenario 11: Date Grouping

**Objective:** Verify events group by date correctly

**Steps:**
1. Load timeline with events from multiple days
2. Scroll through timeline
3. Observe date dividers

**Expected Results:**
- ✅ "Today" shows for today's events
- ✅ "Yesterday" shows for yesterday
- ✅ "Month Day, Year" shows for older dates (e.g., "March 17, 2026")
- ✅ Date dividers sticky during scroll
- ✅ Events under correct date group

**Failure Indicators:**
- Missing date dividers
- Wrong date labels
- Events in wrong date group
- Dividers not sticky

---

### Scenario 12: Empty States

**Objective:** Verify empty states display correctly

**Steps:**
1. Create new session with no events
2. Load timeline
3. Apply filter that matches no events (e.g., search for "xyz123")

**Expected Results:**

**No Events:**
- ✅ Shows "No events yet"
- ✅ Shows "Events will appear here as agents work"
- ✅ No loading spinner

**Filtered - No Results:**
- ✅ Shows "No events yet"
- ✅ Shows "Try adjusting your filters"

**Failure Indicators:**
- Shows loading forever
- Shows error message
- Blank screen

---

### Scenario 13: Performance with Large Datasets

**Objective:** Verify timeline performs well with many events

**Steps:**
1. Load session with 500+ events
2. Load timeline
3. Scroll rapidly through all events
4. Apply and remove filters rapidly
5. Toggle density modes

**Expected Results:**
- ✅ Initial load < 2 seconds
- ✅ Smooth scrolling (no stuttering)
- ✅ Filter changes instant (< 100ms)
- ✅ Density changes instant
- ✅ No memory leaks (check DevTools Memory tab)
- ✅ Pagination loads smoothly

**Failure Indicators:**
- Lag or freezing
- High memory usage (>500MB)
- Scroll stuttering
- Filter changes slow (>500ms)

---

### Scenario 14: Browser Compatibility

**Objective:** Verify timeline works across browsers

**Test in Each Browser:**
- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

**Expected Results:**
- ✅ All features work identically
- ✅ No console errors
- ✅ Correct layout
- ✅ Smooth animations

**Failure Indicators:**
- Features broken in specific browser
- Layout issues
- Console errors

---

## Regression Tests

### Must Not Break:
1. **Terminal Panel:** Should still work alongside timeline
2. **Task Board:** Should still be accessible
3. **Agent Cards:** Should not be affected
4. **WebSocket:** Should not conflict with timeline polling
5. **Navigation:** Should be able to switch tabs without issues

---

## Test Execution Checklist

- [ ] Run all scenarios on dev environment (port 7891)
- [ ] Test with small dataset (10 events)
- [ ] Test with medium dataset (100 events)
- [ ] Test with large dataset (500+ events)
- [ ] Test all 15 event types individually
- [ ] Test all filter combinations
- [ ] Test all density modes
- [ ] Test live mode ON and OFF
- [ ] Test browser compatibility
- [ ] Check console for errors
- [ ] Check Network tab for API calls
- [ ] Verify no memory leaks
- [ ] Take screenshots of all event types
- [ ] Record video demo of key features

---

## Success Criteria

**All tests must pass:**
- ✅ No console errors
- ✅ All 15 event types render correctly
- ✅ Pagination loads more events smoothly
- ✅ All filters work (category, agents, search)
- ✅ Debounce prevents excessive API calls
- ✅ Live mode polls correctly
- ✅ All density modes display correctly
- ✅ Performance acceptable (<2s load, smooth scroll)
- ✅ No regressions in other features
- ✅ Works in all major browsers

---

## Known Limitations

1. **MultiSelect Backend:** Backend only supports single `agentId` parameter, so multiple agents are filtered on frontend
2. **Search Backend:** Not yet implemented on backend, search is client-side only
3. **Virtualization:** Not implemented yet, performance may degrade with 1000+ events
4. **WebSocket Live:** Uses polling instead of pure WebSocket push

---

## Reporting Issues

**When reporting test failures, include:**
- Scenario number and name
- Steps to reproduce
- Expected vs actual behavior
- Screenshots/video
- Browser and OS version
- Console errors (if any)
- Network activity (API calls)

---

**Test Plan Version:** 1.0
**Last Updated:** 2026-03-19
**Next Review:** After P1 features implemented (virtualization, live mode optimization)
