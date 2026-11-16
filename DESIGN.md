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

Court palette, from the HTML styling reference the owner supplied on 2026-11-17: emerald and lime on slate, light pages with dark chrome. It replaced the Pulsering choice.

```css
:root {
  --color-bg: #F8FAFC;        /* page, slate-50 */
  --color-surface: #FFFFFF;   /* cards, tables, inputs */
  --color-fg: #1E293B;        /* body text */
  --color-primary: #0F172A;   /* headings, dark chrome */
  --color-muted: #64748B;     /* secondary text */
  --color-label: #475569;     /* uppercase field labels */
  --color-border: #E2E8F0;    /* card borders, hairlines */
  --color-control: #CBD5E1;   /* input and outline-button borders */
  --color-accent: #047857;    /* primary action, links, focus, countdown */
  --color-on-accent: #FFFFFF;
  --color-lime: #A3E635;      /* highlight on dark chrome only */
  --color-success: #065F46;   /* confirmed */
  --color-warning: #92400E;   /* pending, hold running */
  --color-danger: #BE123C;    /* expired, cancelled, rejected */
}
```

**Usage rules:** Pages are light; the top bar, the phone tab bar, the calendar hero and the sign-in gateway are dark (slate-900, or deep green with faint court lines). Lime appears only on those dark areas. The reference fills buttons with emerald-600; this build uses emerald-700 (`#047857`) because white text on emerald-600 measures 3.8:1, below WCAG AA, and emerald-700 measures 5.5:1. Semantic colors appear as tinted status chips with text labels. Chips map one-to-one to the request states in FEATURES.md §2: `pending` (warning), `awaiting_payment` (warning, with countdown), `confirmed` (success), `rejected`, `expired`, `cancelled` (danger). Chip text is the Bahasa Indonesia label for the state (DEC-019). Dark areas re-tint the same components by overriding the tokens under the `.on-dark` class, so no component has a second set of styles.

## 5. Typography & Type Scale

- **All text:** `Inter`, loaded through `next/font/google`, which self-hosts the files at build time: no request to Google at runtime and no layout shift.
- **Numeric/Data:** Inter with tabular numerals at weight 600: wallet amounts, timers, seat counts.

| Level | Size | Weight | Line-Height | Tracking | Rationale |
|:---|:---|:---|:---|:---|:---|
| h1 | clamp(1.5rem, 5vw, 1.875rem) | 800 | 1.2 | -0.025em | Page titles |
| h2 | 1.25rem | 800 | 1.3 | -0.025em | Section heads |
| h3 | 1rem | 800 | 1.35 | -0.025em | Panel titles |
| body | 0.9375rem | 400 | 1.5 | 0 | Default (16px in inputs on phones) |
| caption | 0.8125rem | 500 | 1.4 | 0 | Hints, secondary lines |
| label | 0.6875rem | 700 | 1.4 | 0.08em, uppercase | Field labels, table heads, tile labels |

**Shape and motion:** buttons and inputs are 12px rounded rectangles; cards are 16px with a 1px border and a soft shadow; dialogs and gateway panels are 24px; chips are pills. The only decorative motion is the dashed shuttle trajectory on the sign-in gateway. Motion respects `prefers-reduced-motion`.

Not taken from the reference: its Court Arranger, skill ratings, win leaderboard, demo quick-login passes and player switcher. They are features outside PRD.md, not styling.

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

- **Primary:** emerald fill with a white bold label and a soft emerald shadow, one per viewport (e.g., *Approve & Charge*, *Pay Now*). On dark areas the fill is lime with a near-black label.
- **Secondary:** white with a 1px slate outline; the outline turns emerald on hover.
- **Tertiary:** text-only emerald.
- **States:** hover = slight brighten; focus = 2px emerald ring with 2px offset; disabled = 40% opacity + `cursor:not-allowed`; selected row = 4% tint; active nav item = emerald pill (top bar) or emerald label (phone tab bar). All contrast meets WCAG AA.
- **Navigation:** a sticky dark top bar with the logo and, from 768 px, a pill group of nav items (icons only below 1280 px, with labels above). Phones keep the bottom tab bar.
- **Sign-in gateway:** login, register and the guest nickname form share one full-screen dark page: court-line backdrop, the form in a glass card with a three-way mode switch, and a club guide (FAQ) built from the rules in FEATURES.md.
- **Calendar hero:** a deep-green banner with the greeting, the create action for hosts, and two counts (open sessions, scheduled).

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