# DESIGN.md: ShuttleCircle

## 1. Design Read (Evidence-Based)

- **Product:** ShuttleCircle — browser-based badminton community management platform (scheduling, join approval, payment, wallet, match documentation).
- **Target Audience:** Indonesian badminton community organizers (superadmin/admin/host) and casual-to-regular players (member/guest).
- **Product Type:** SaaS Application (operational dashboard with a public-facing calendar/join surface).
- **Primary User Goal:** Approve join requests and complete payment/seat confirmation within a 30-minute hold window (DEC-002, DEC-003).
- **User Roles & Workflows:**
  - *Guest:* nickname cookie session, view calendar/location, request join, then prompted to convert (DEC-001, DEC-004).
  - *Member:* calendar (1 month back → 3 months ahead), request join, pay (wallet auto-deduct or QR), history, wallet top-up, reward view.
  - *Host:* create/edit own match, approve/reject requests, upload media.
  - *Admin/Superadmin:* assign hosts, wallet/financial dashboard, manual credit (DEC-005), 3-month history.
- **Brand / Aesthetic Direction:** Utilitarian, court-side operational, high-contrast editorial. Neutral surfaces, hairline rules, data-first tables. Accent reserved for the live seat-hold countdown and primary CTAs.
- **Key Personality Traits:** Disciplined, legible, time-aware.

## 2. Design Dials (Context-Specific)

| Dial | Value | Rationale |
|:---|:---|:---|
| DESIGN_VARIANCE | 3 | Operational consistency across request lists, calendars, and wallet tables. Layouts must be predictable for hosts approving at speed. |
| MOTION_INTENSITY | 2 | Task velocity dominates. Motion limited to the 30-minute countdown pulse and payment-state transitions. |
| VISUAL_DENSITY | 7 | Admin/host screens are data-heavy (rosters, wallet ledger, financial dashboard). Members get a lighter calendar surface. |

## 3. Visual Identity & Product-Type Adaptation

The system adapts a **dashboard-first** grammar: persistent left rail (role-scoped nav), a top context bar (current match / date range), and a main scanning region. Calendar and request list are the two hero surfaces. Distinctiveness comes from **typographic contrast and hairline grid discipline**, not decoration: no gradients, no frosted glass, no rounded-card stacks. Status is always a text label with a semantic color chip, never a color-alone signal.

## 4. Semantic Color System

Palette from the owner's design reference `design-systems-56/17-pulsering`, chosen by the owner: a dark, kinetic system with one halogen green. It replaced the earlier Limeledger choice.

```css
:root {
  --color-bg: #0A0C0B;        /* page, near-black */
  --color-surface: #111513;   /* panels, tables, inputs */
  --color-fg: #EAF2EC;        /* primary text */
  --color-muted: #8A9890;     /* secondary text, captions */
  --color-border: #26302B;    /* hairlines, ring outlines */
  --color-accent: #7CFF4F;    /* the only bright colour: primary action, focus, countdown, active nav, links */
  --color-on-accent: #07110A; /* text on a green fill */
  --color-success: #7CFF4F;   /* confirmed */
  --color-warning: #F5B841;   /* pending, hold running */
  --color-danger: #FF5A5F;    /* expired, cancelled, rejected */
}
```

**Usage rules:** Backgrounds stay near-black. Halogen green is the single signal colour; text on a green fill is near-black. The glow (`0 0 32px -4px rgba(124,255,79,.35)`) belongs to the one primary action per viewport only. Semantic colors appear as status chips with text labels. Chips map one-to-one to the request states in FEATURES.md §2: `pending` (warning), `awaiting_payment` (warning, with countdown), `confirmed` (success), `rejected`, `expired`, `cancelled` (danger). Chip text is the Bahasa Indonesia label for the state (DEC-019). Amber `#F5B841` was added for warning because Pulsering defines none. Pulsering's cyan secondary accent is not used. All text pairs measure above 6:1 on both background and surface. Native controls follow the theme through `color-scheme: dark`.

## 5. Typography & Type Scale

- **Display (h1, h2):** `Outfit` 600.
- **Body / UI:** `Inter`.
- **Numeric/Data:** `JetBrains Mono`, tabular numerals: wallet amounts, timers, seat counts.

All three load through `next/font/google`, which self-hosts the files at build time: no request to Google at runtime and no layout shift.

| Level | Size | Weight | Line-Height | Tracking | Rationale |
|:---|:---|:---|:---|:---|:---|
| h1 | clamp(1.5rem, 6vw, 2rem) | 600 | 1.15 | -0.03em | Page titles |
| h2 | 1.5rem | 600 | 1.25 | -0.01em | Section heads |
| h3 | 1.125rem | 600 | 1.3 | 0 | Panel titles |
| body | 0.9375rem | 400 | 1.5 | 0 | Default (16px in inputs on phones) |
| caption | 0.8125rem | 500 | 1.4 | 0.01em | Labels, status |
| mono | 0.875rem | 500 | 1.4 | 0 | Amounts, timers |

**Shape and motion:** buttons and inputs are 16px rounded rectangles with a 1.5px border; a button morphs to a pill on hover (200 ms), which is Pulsering's signature. Chips are pills. Not adopted from Pulsering: uppercase labels (captions here are often full sentences), concentric double rings, bento tiles and the centre dock action, because section 8 (card discipline) and the dense admin tables come first. Motion respects `prefers-reduced-motion`.

## 6. Layout Strategy & Anti-Repetition Rules

- **No repeated "Hero → 3 Cards".** Each surface uses a structural pattern matched to its task:
  - *Calendar:* month grid (desktop) / agenda list (mobile).
  - *Request list:* master/detail split-pane (list left, request detail + approve/reject right).
  - *Wallet:* ledger table with a summary strip above.
  - *Match history:* timeline grouped by month, expandable roster rows.
  - *Match create/edit:* single-column form with a sticky summary aside.
- **Grid & Spacing:** 12-col grid, 24px gutters, 8px base spacing unit (8/16/24/32/48). Max content width 1280px; forms capped at 640px.

## 7. Anti-AI-Slop Rules

| Avoid | Prefer |
|:---|:---|
| Generic three-card feature grids | Structured tables, split-pane, calendar grid |
| Every section in a rounded card | Whitespace + hairline `--color-border` dividers |
| Purple/blue gradient backgrounds | Flat `--color-bg` with sparse semantic accents |
| Decorative icons/badges | Status text chips, functional iconography only |
| Decorative animation | Opacity/transform feedback only |

## 8. Card & Container Discipline

Cards are **allowed only** for: calendar day cells, request list rows (as bordered list items, not floating cards), and wallet summary tiles. Cards are **forbidden** for: form sections, history timeline, page headers, and any standard text block. **No card nesting.** Panels use a single hairline border; interior grouping uses spacing only.

## 9. Component Rules & Action Hierarchy

- **Primary:** green fill with near-black label and a glow, one per viewport (e.g., *Approve & Charge*, *Pay Now*).
- **Secondary:** 1.5px ring outline in `--color-border`; the ring turns green on hover.
- **Tertiary:** text-only green.
- **States:** hover = 6% darken; focus = 2px green ring with 2px offset; disabled = 40% opacity + `cursor:not-allowed`; selected row = light 4% tint; active nav item = light 6% tint + 2px green bar. All contrast meets WCAG AA.

## 10. Behavioral Responsive Design

| Breakpoint | Behavior |
|:---|:---|
| ≥1024px (desktop, landscape tablet) | Left rail nav, split-pane request list, month calendar grid |
| 768–1023px (portrait tablet) | Rail collapses to icon bar; month calendar grid kept; split-pane stacks (list, then detail as a full page) |
| <768px (phone) | Bottom tab bar; calendar → agenda list; tables become stacked rows showing primary columns; sticky payment countdown bar; forms full width |

The bottom tab bar is role-scoped: Calendar, My Requests, Wallet, History for members; approvers get Approvals in place of History, which moves under the profile menu; guests see Calendar and My Requests only. The layout must work from 360 px wide with no horizontal scroll. Inputs use 16 px text on phones so iOS does not zoom on focus. Bottom bars respect `env(safe-area-inset-bottom)`.

## 11. States (Loading, Empty, Error)

- **Loading:** skeleton rows matching table/calendar cell shapes (no spinners).
- **Empty:** contextual copy + next action (e.g., "No join requests yet — share the match link." + *Copy Link*).
- **Error:** inline alert with the reason in plain words (hold expired, gateway unavailable, match full) and one next action: *Retry*, *Create account* (DEC-004), or *Back to calendar*.
- **Live:** the payment page and request status refresh by polling (ARCHITECTURE.md §3); the countdown runs on the client from `hold_expires_at` and the page re-checks the server when it reaches zero.

## 12. Accessibility & Inclusivity (WCAG 2.1 AA)

Keyboard-navigable calendar and request list; visible 2px focus ring with offset; ARIA roles on tables and tabs; touch targets ≥44×44px; status conveyed by text + icon, never color alone; the 30-minute countdown is visible every second but announced through `aria-live="polite"` only at 10, 5 and 1 minutes left and at expiry, so screen readers are not flooded. Motion respects `prefers-reduced-motion`.

## 13. Design Rationale

Density and low variance serve hosts approving requests within a 12-hour p95 target and members acting inside a 30-minute hold (DEC-002/003). The accent is deliberately scarce so the live countdown and payment CTA dominate attention. Neutral-first surfaces keep wallet and roster data legible, while the calendar and split-pane patterns match the two core workflows.

## 14. NO Invented Design Content Rule

No fake testimonials, logos, statistics, or screenshots. All copy derives from PRD features or mock data shaped from real entities (matches, requests, wallet ledger). Currency is IDR formatted `Rp 50.000` (DEC-019). Values still undecided (membership price) hide their feature instead of showing a placeholder.

## 15. Design Pre-Flight Checklist

- [ ] Design is derived from PRD/project context.
- [ ] Design Read is specific.
- [ ] Design dials are intentional.
- [ ] Visual direction is justified.
- [ ] Color hierarchy is intentional.
- [ ] Typography is intentional.
- [ ] Cards are not overused.
- [ ] Layouts are not repetitive.
- [ ] No generic AI aesthetic was introduced without justification.
- [ ] Motion has a purpose.
- [ ] Responsive behavior is defined.
- [ ] Loading states are defined where relevant.
- [ ] Empty states are defined where relevant.
- [ ] Error states are defined where relevant.
- [ ] Accessibility is defined.
- [ ] No fake content was invented.
- [ ] Design feels specific to the product.
- [ ] A coding agent can implement the design without inventing major visual decisions.
- [ ] Design System is cohesive and reusable.