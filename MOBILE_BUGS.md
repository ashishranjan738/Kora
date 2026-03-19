# Mobile Responsive Issues

**Last Updated:** 2026-03-19
**Status:** 30+ issues previously fixed, remaining issues documented below

## Test Environments
- **Mobile:** 375px (iPhone SE), 414px (iPhone Pro Max)
- **Tablet:** 768px (iPad Mini), 1024px (iPad Pro)
- **Desktop:** 1920px

---

## Critical (P0) - Must Fix

### 1. ❓ TaskBoard Column Width on Mobile
- **Issue:** TaskBoard columns may not be properly sized on screens <768px
- **Expected:** Single column layout OR horizontal scrollable columns
- **Current State:** Unknown - needs manual testing
- **Files:** `packages/dashboard/src/components/TaskBoard.tsx`, `src/index.css`
- **Test:** Load TaskBoard on 375px viewport, verify all columns are accessible

### 2. ❓ Modal Overflow on Small Screens
- **Issue:** Large modals (Create Task, Edit Task, Playbook config) may overflow viewport
- **Expected:** Modals should be scrollable and fit within viewport
- **Current State:** Dialog CSS exists (lines 3292-3315) but Mantine Modals may not be covered
- **Files:** All components using Mantine Modal
- **Test:** Open Create Task modal on 375px, verify scrollability

### 3. ❓ Terminal Responsiveness on Tablets (768px-1024px)
- **Issue:** Terminal may have sizing issues in the intermediate tablet range
- **Expected:** Terminal should be readable and functional
- **Current State:** Mobile (<768px) has styles, but 768-1024px range unclear
- **Files:** `packages/dashboard/src/components/AgentTerminal.tsx`
- **Test:** Load agent terminal on iPad (768px), verify text is readable

---

## High Priority (P1) - Should Fix

### 4. ❓ AgentView Header Stats Overflow
- **Issue:** Header stats (uptime, tokens, cost) may overflow on very small screens (<375px)
- **Expected:** Header should wrap or hide non-critical stats
- **Current State:** Header has `flex-wrap: wrap` but may still overflow
- **Files:** `packages/dashboard/src/pages/AgentView.tsx` (lines 217-268)
- **Test:** Load AgentView on 320px viewport, check if all header elements fit

### 5. ❓ Navigation Menu Accessibility on Mobile
- **Issue:** Top navigation may be hard to access; bottom nav exists but needs testing
- **Expected:** Bottom navigation works correctly on mobile, top nav hidden or hamburger
- **Current State:** Bottom nav CSS exists (lines 3629-3653) but functionality untested
- **Files:** `packages/dashboard/src/App.tsx`, `src/index.css`
- **Test:** Navigate between pages on mobile using bottom nav

### 6. ❓ Timeline View Filters on Mobile
- **Issue:** Timeline filters may not be mobile-friendly (dropdowns, date pickers)
- **Expected:** Filters should be usable on touch devices
- **Current State:** Unknown - Timeline is newer feature
- **Files:** `packages/dashboard/src/components/timeline/*.tsx`
- **Test:** Use Timeline filters on mobile (375px), verify touch interactions

### 7. ❓ Agent Card Actions Button Wrapping
- **Issue:** Agent card action buttons may wrap awkwardly on narrow screens
- **Expected:** Buttons should stack vertically or use overflow menu
- **Current State:** Some wrap styles exist (line 3402-3409) but may need refinement
- **Files:** `packages/dashboard/src/components/AgentCard*.tsx`
- **Test:** Load SessionDetail with 5+ agents on mobile, check button layout

---

## Medium Priority (P2) - Nice to Have

### 8. ❓ TaskBoard Drag-and-Drop on Touch Devices
- **Issue:** Drag-and-drop may not work well on touch screens
- **Expected:** Touch drag should work OR alternative method provided
- **Current State:** Unknown - React Beautiful DnD or similar may have touch issues
- **Files:** `packages/dashboard/src/components/TaskBoard.tsx`
- **Test:** Try dragging tasks on iPad/mobile, verify functionality

### 9. ❓ Monaco Editor Responsiveness
- **Issue:** Monaco editor (for YAML playbooks) may not be touch-friendly
- **Expected:** Editor should be usable on tablets, maybe readonly on phones
- **Current State:** Unknown
- **Files:** Components using `@monaco-editor/react`
- **Test:** Open playbook editor on tablet, try editing code

### 10. ❓ Stats Bar Stacking on Mobile
- **Issue:** Stats bar items may not stack cleanly on very narrow screens
- **Expected:** Items should stack with proper spacing and alignment
- **Current State:** CSS exists (lines 3183-3196) but visual result untested
- **Files:** `packages/dashboard/src/pages/SessionDetail.tsx`, similar pages
- **Test:** Load SessionDetail on 375px, verify stats bar layout

### 11. ❓ Form Input Sizing on iOS
- **Issue:** Form inputs <16px font-size cause iOS to zoom
- **Expected:** All inputs should be 16px+ on mobile
- **Current State:** One fix exists (line 3554) but may need more
- **Files:** All components with text inputs
- **Test:** Focus on input fields on iOS Safari, verify no auto-zoom

### 12. ❓ Table Responsiveness (if any tables exist)
- **Issue:** Data tables don't usually work well on narrow screens
- **Expected:** Tables should scroll horizontally or switch to card layout
- **Current State:** Unknown if tables are used
- **Files:** Search for `<table>` tags in components
- **Test:** N/A - check if tables exist first

### 13. ❓ Toast Notifications Position on Mobile
- **Issue:** Toast notifications may overlap important UI elements
- **Expected:** Toasts should appear in safe area, not cover nav or actions
- **Current State:** Some toast CSS exists (lines 3588-3595, 3616-3624)
- **Files:** Toast/notification components
- **Test:** Trigger notifications on mobile, verify position

### 14. ❓ Playbook Agent Config Grid on Mobile
- **Issue:** Multi-agent config grid may be hard to use on phones
- **Expected:** Grid should stack into single column
- **Current State:** CSS exists (lines 3381-3388) but needs visual verification
- **Files:** `packages/dashboard/src/pages/PlaybookConfig.tsx` or similar
- **Test:** Configure multi-agent playbook on mobile, verify usability

### 15. ❓ Breadcrumb Truncation
- **Issue:** Long breadcrumb paths may overflow on narrow screens
- **Expected:** Breadcrumbs should truncate or wrap gracefully
- **Current State:** Font size reduced (line 3392) but truncation unclear
- **Files:** Components with breadcrumb navigation
- **Test:** Navigate deep paths on mobile, check breadcrumb display

---

## Low Priority (P3) - Future Improvements

### 16. ❓ Terminal Font Size on Mobile
- **Issue:** Terminal text may be too small on phones
- **Expected:** Configurable font size OR readable default
- **Current State:** Unknown
- **Files:** `packages/dashboard/src/components/AgentTerminal.tsx`
- **Test:** Read terminal output on 375px screen

### 17. ❓ Session Grid Card Sizing
- **Issue:** Session cards may be too large/small on different screen sizes
- **Expected:** Cards should be appropriately sized for viewport
- **Current State:** Single column (line 3200) but card internals untested
- **Files:** `packages/dashboard/src/pages/AllSessions.tsx`
- **Test:** View session list on various screen sizes

### 18. ❓ Empty State Button Sizing
- **Issue:** Empty state action buttons may be hard to tap
- **Expected:** Touch-friendly button sizes (44px+)
- **Current State:** CSS exists (lines 3346-3349) but may need refinement
- **Files:** All components with empty states
- **Test:** Tap empty state buttons on touch device

### 19. ❓ PWA Install Prompt on Mobile
- **Issue:** PWA features may not be fully implemented
- **Expected:** "Add to Home Screen" prompt works correctly
- **Current State:** PWA foundation exists (commit 8cf6785) but needs testing
- **Files:** `public/manifest.json`, service worker files
- **Test:** Test PWA installation on iOS Safari and Android Chrome

### 20. ❓ Landscape Orientation Support
- **Issue:** Mobile landscape may have layout issues
- **Expected:** All views should work in both portrait and landscape
- **Current State:** Unknown - no landscape-specific styles seen
- **Files:** General CSS and components
- **Test:** Rotate device to landscape, verify all pages work

---

## Previously Fixed Issues (Historical Record)

Based on commits:
- **PR #82:** Mobile polish (tab scroll, compact cards, log viewer)
- **PR #19:** Mantine v8 + mobile responsive improvements
- **Commit cbc70ed:** Tab scroll, compact cards, log viewer, mosaic hide
- **Commit c93e6d4:** Mantine v8 migration + mobile responsive + UI improvements

### ✅ Fixed: Tab Bar Horizontal Scroll
- Tabs now scroll horizontally on mobile with touch support
- CSS: lines 3230-3247

### ✅ Fixed: Agent Grid Single Column
- Agent grid collapses to single column on mobile
- CSS: line 3250-3252

### ✅ Fixed: Session Header Stacking
- Session header stacks vertically on narrow screens
- CSS: lines 3204-3227

### ✅ Fixed: Touch-Friendly Button Sizes
- All buttons have 44px min-height for touch targets
- CSS: lines 3397-3399

### ✅ Fixed: Dialog Responsive Sizing
- Dialogs adapt to mobile viewport size
- CSS: lines 3292-3315

### ✅ Fixed: Bottom Navigation on Mobile
- Bottom nav appears on screens <768px
- CSS: lines 3629-3653

### ✅ Fixed: Agent View Layout Stacking
- Agent view stacks vertically on mobile
- CSS: lines 3255-3272

### ✅ Fixed: Multi-Agent Grid Single Column
- Multi-agent view uses single column on mobile
- CSS: lines 3275-3282

### ✅ Fixed: Playbook Card Responsive Padding
- Playbook cards have mobile-friendly padding
- CSS: lines 3356-3378

### ✅ Fixed: iOS Input Zoom Prevention
- Message inputs use 14px font to prevent iOS zoom
- CSS: line 3554

---

## Testing Checklist

### Device Testing
- [ ] iPhone SE (375px) - Portrait
- [ ] iPhone SE (375px) - Landscape
- [ ] iPhone Pro Max (414px) - Portrait
- [ ] iPhone Pro Max (414px) - Landscape
- [ ] iPad Mini (768px) - Portrait
- [ ] iPad Mini (768px) - Landscape
- [ ] iPad Pro (1024px) - Portrait
- [ ] iPad Pro (1024px) - Landscape

### Page Testing
- [ ] AllSessions page
- [ ] SessionDetail page (with multiple agents)
- [ ] AgentView page
- [ ] TaskBoard component
- [ ] Timeline view
- [ ] Playbook configuration
- [ ] Modal dialogs (Create Task, Edit Task, etc.)
- [ ] Agent Terminal

### Interaction Testing
- [ ] Touch scrolling
- [ ] Button tapping (all touch targets 44px+)
- [ ] Form input (no iOS zoom)
- [ ] Drag-and-drop (if applicable)
- [ ] Navigation (top nav + bottom nav)
- [ ] Dropdown menus
- [ ] Date pickers
- [ ] Modal scrolling

---

## Notes

1. **Chrome DevTools Device Mode** can be used for initial testing
2. **Real device testing** is required for final validation (especially touch interactions)
3. **iOS Safari** and **Android Chrome** should both be tested
4. **PWA mode** testing is separate from browser testing
5. Many responsive styles already exist - focus on **visual verification** and **edge cases**

---

## Next Steps

1. Set up device testing environment (Chrome DevTools + real devices if available)
2. Test all P0 issues first
3. Document findings with screenshots
4. Implement fixes for confirmed issues
5. Re-test after fixes
6. Update this document with results
