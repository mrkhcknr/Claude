# Prompt Templates

Copy-paste prompts for extending the shell app **consistently** — new fake apps, screens,
components, themes, system interactions, cross-links, and scripted demos — so every
addition honors the core architecture.

Each template is built on two sets of best practices:

- **AI prompting:** assign a role, supply context (point at the repo docs), state explicit
  constraints and non-goals, ask for a **plan before code**, specify the output/verification,
  and require the model to flag ambiguities instead of guessing.
- **PM requirements writing:** a user story (*As a … I want … so that …*), **acceptance
  criteria in Given/When/Then**, explicit **scope / non-goals**, edge cases, and a
  **Definition of Done**.

> **How to use:** copy a template's code block, replace every `〈PLACEHOLDER〉`, delete lines
> you don't need, and paste it to Claude Code in your Xcode project. Keep the "Guardrails"
> and "Before you code" lines — they are what keep additions on-architecture.

---

## Global preamble (paste once at the top of any session)

```text
You are working in this repository as an iOS engineer who knows the codebase.
Before doing anything, read CLAUDE.md, ARCHITECTURE.md, and docs/BUILD_PLAN.md and
treat their rules as binding. This is a SwiftUI shell app that hosts self-contained
"fake app" experiences for high-fidelity wireframe prototyping — interactive-but-fake
UI, no real functionality yet, mock-first behind protocols.

Non-negotiable constraints:
- Modular SPM packages; sub-apps depend only on Core and NEVER import another sub-app.
- Cross-app navigation goes through the RootRouter by DemoRoute identity, never a type ref.
- Components read tokens from @Environment(\.theme) — no hardcoded colors or fonts.
- Native SwiftUI + Apple HIG; SF Symbols for Apple themes, brand marks for brand themes.
- Services depend on protocols; Mock* today, Live* later, with zero UI changes.
- SystemChrome surfaces are fake and Apple-styled; never wire to real auth/payment.
- Simulator-first: no device-only APIs in the core path; haptics are enhancement-only.

Working style:
- First restate your understanding and give me a short PLAN. Do not write code until I
  approve the plan.
- Call out any ambiguity or architectural trade-off and ask, rather than guessing.
- Work in small, runnable increments. After each, tell me exactly how to verify in the
  iOS Simulator.
```

---

## Template 1 — Add a new fake app (sub-app)

```text
GOAL
Add a new fake app: 〈Fake Name, e.g. "Fake Delta Airlines"〉 as its own SPM package
Packages/Features/Fake〈Name〉App, self-registering via a DemoManifest.

CONTEXT
- Mimics the look & feel of: 〈real app / archetype, e.g. "Delta airline app"〉
- Theme: 〈existing ThemeID, or "new brand theme — see Template 4 first"〉
- Route scheme: 〈fakename://〉
- Primary Apple archetype to borrow structure from: 〈Settings-style Form / Music-style
  TabView + shelves / TV-style hero + shelves / dashboard〉

USER STORY
As a 〈demo presenter / stakeholder〉, I want to 〈walk through the 〈Name〉 experience〉
so that 〈what the demo should prove〉.

SCOPE (screens to include)
1. 〈Screen — e.g. Home〉: 〈what's on it, which DesignSystem components〉
2. 〈Screen — e.g. Detail〉: 〈…〉
3. 〈Screen — e.g. a flow like checkout / transfer〉: 〈…〉

NON-GOALS
- No real 〈network / auth / payment〉 — mock-first only.
- 〈anything explicitly out of scope for this pass〉

DATA
- Back screens with 〈ServiceName〉Servicing (protocol) + Mock〈ServiceName〉Service using
  ScenarioKit fixtures. Personas to support: 〈e.g. "loyalty member", "first-time flyer"〉.

ENTRY ROUTES (for cross-links / presenter)
- 〈fakename://home〉, 〈fakename://〈screen〉/〈id〉〉  — list the screens others may deep-link to.

ACCEPTANCE CRITERIA
- Given the shell catalog, when it loads, then "〈Fake Name〉" appears without any edit to
  shell code (self-registered via manifest).
- Given a tap on the catalog row, when the app opens, then its root 〈NavigationStack /
  TabView〉 renders in the 〈theme〉 in both light and dark mode.
- Given 〈screen X〉, when I 〈action〉, then 〈expected result〉.
- Given a deep link to 〈fakename://…〉, when routed, then the app opens on 〈that screen〉.

GUARDRAILS
- Depend only on Core. Do not import another sub-app.
- No hardcoded colors/fonts — read @Environment(\.theme).

BEFORE YOU CODE
Restate the plan: package layout, the DemoManifest, the screen list, the service protocol,
and the entry routes. Wait for my approval.

DEFINITION OF DONE
Builds and runs in the Simulator; self-registers; all acceptance criteria pass in light
and dark; entry routes resolve. Tell me the exact steps to verify.
```

---

## Template 2 — Add a screen / feature to an existing fake app

```text
GOAL
Add 〈screen/feature name〉 to Fake〈Name〉App.

USER STORY
As a 〈user〉, I want 〈capability〉 so that 〈benefit〉.

PLACEMENT
- Reached from: 〈which existing screen + control〉.
- New route: 〈fakename://〈path〉〉. Register it in the local router; add to manifest
  entryRoutes only if other apps or the presenter should deep-link to it.

UI
- Compose from existing DesignSystem components: 〈list them〉. If a needed component
  doesn't exist, STOP and tell me — we add it via Template 3, not inline.

ACCEPTANCE CRITERIA (Given / When / Then)
- Given 〈precondition〉, when 〈action〉, then 〈observable result〉.
- Given 〈edge case, e.g. empty / loading / error state〉, when 〈…〉, then 〈…〉.

NON-GOALS
- 〈out of scope〉

GUARDRAILS
- Reuse components; theme-driven; mock data via the existing service protocol.

BEFORE YOU CODE
Give me the plan (route, components, state, mock data). Wait for approval.

DEFINITION OF DONE
Runs in Simulator; criteria pass in light + dark + Dynamic Type; navigation back/forward
is correct. Give verification steps.
```

---

## Template 3 — Add a reusable DesignSystem component

```text
GOAL
Add a reusable component 〈ComponentName〉 to DesignSystem 〈Common | MediaUI | …〉.

WHY IT'S SHARED
Used by: 〈which sub-apps / screens〉. It must work under every Theme, not just one.

API
- Inputs: 〈parameters / model〉.
- Behavior: 〈interaction, states: default / pressed / disabled / loading / empty〉.

ACCEPTANCE CRITERIA
- Given AppleTheme and each brand theme, when rendered, then it reads correct tokens
  (color, radius, type) with NO hardcoded values.
- Given light and dark mode, when rendered, then contrast stays legible.
- Given Dynamic Type at 〈largest accessibility size〉, when rendered, then it doesn't clip
  or overlap.

GUARDRAILS
- Read all styling from @Environment(\.theme). Native SwiftUI only.
- Add a SwiftUI #Preview showing it across themes + light/dark.

BEFORE YOU CODE
Plan the API and the token roles it will consume. Wait for approval.

DEFINITION OF DONE
Component + preview build; appears correctly in ComponentGallery across all themes.
```

---

## Template 4 — Add a new brand theme

```text
GOAL
Add 〈BrandTheme〉 (ThemeID .〈brand〉) so sub-apps can adopt the 〈Brand〉 look with ZERO
component changes.

BRAND TOKENS (provide explicit light + dark)
- accent: 〈light hex〉 / 〈dark hex〉
- background / secondaryBackground / label / separator: 〈…〉
- cornerRadius: 〈pt〉   typography: 〈title / body intent〉   motion: 〈standard / springy / expressive〉
- iconography: 〈SF Symbols | bundled brand marks (list assets)〉

ACCEPTANCE CRITERIA
- Given any existing DesignSystem component, when rendered under 〈BrandTheme〉, then it
  restyles correctly with no code change to the component.
- Given light and dark, when rendered, then both are legible and on-brand (no naive invert).
- Given ComponentGallery, when I pick 〈BrandTheme〉, then every component reflects it.

GUARDRAILS
- Only add a Theme conformance + assets. Do NOT modify any component.

BEFORE YOU CODE
List the token values you'll set and any bundled assets. Wait for approval.

DEFINITION OF DONE
Theme selectable in ComponentGallery and adoptable by a sub-app; renders in light + dark.
```

---

## Template 5 — Add a fake iOS system interaction (SystemChrome)

```text
GOAL
Add / use a fake iOS system surface: 〈Face ID | Apple Pay/IAP sheet | permission prompt |
system alert | notification banner | app launch animation〉.

WHERE
Invoked from: 〈sub-app + screen + trigger〉, via the shell's SystemUIPresenting service:
  〈e.g. let r = await system.authenticate(reason: "Confirm transfer")〉

USER STORY
As a 〈user〉, I want 〈the system interaction〉 so that 〈the demo feels like a real iOS app〉.

ACCEPTANCE CRITERIA
- Given the trigger, when invoked, then the Apple-styled overlay appears ABOVE the app,
  using system semantics even though the app uses 〈brand〉 theme.
- Given the 〈success / cancel / deny〉 path, when it resolves, then the app 〈does X / Y〉.
- Given the Simulator (no real biometrics), when run, then the result is simulated cleanly.

GUARDRAILS (do not violate)
- SystemChrome is a NON-FUNCTIONAL simulation. Do NOT import or call LocalAuthentication,
  StoreKit, PassKit, or any real auth/payment/permission API. Collect no real credentials
  or payment data. Return canned results only.

BEFORE YOU CODE
Plan the surface, the simulated outcomes, and how the calling screen consumes the result.
Wait for approval.

DEFINITION OF DONE
Runs in Simulator; overlay is Apple-styled regardless of app theme; each outcome path
drives the app correctly. Give verification steps.
```

---

## Template 6 — Add a cross-link between two fake apps

```text
GOAL
From Fake〈Source〉App 〈screen〉, launch Fake〈Target〉App at 〈target screen〉.

MECHANISM (required)
- Navigate via RootRouter.navigate(to: DemoRoute) using the target's route string:
  〈faketarget://〈path〉〉.
- The source must NOT import the target. If 〈faketarget://…〉 isn't in the target's
  manifest entryRoutes, add it there first.

ACCEPTANCE CRITERIA
- Given 〈source screen〉, when I tap 〈control〉, then the shell switches to Fake〈Target〉App
  and its local router restores to 〈target screen〉.
- Given no compile-time dependency, when built, then Fake〈Source〉App does not import
  Fake〈Target〉App (verify the import list).

BEFORE YOU CODE
Confirm the target entry route exists (or plan to add it) and show the navigate() call.
Wait for approval.

DEFINITION OF DONE
Cross-link works in Simulator; dependency graph still shows no sub-app→sub-app import.
```

---

## Template 7 — Author a scripted presenter demo

```text
GOAL
Create a DemoScript "〈title〉" that walks these destinations in order for a live demo.

STEPS (each = a DemoRoute + optional scenario/theme + a teleprompter note)
1. route: 〈fakeapp://…〉  scenario: 〈persona〉  note: "〈what to say / show〉"
2. route: 〈…〉            note: "〈…〉"
3. 〈…〉

ACCEPTANCE CRITERIA
- Given the presenter overlay, when I select "〈title〉", then step 1 loads the right screen,
  theme, and persona.
- Given I advance, when I go next/prev, then each step navigates via RootRouter and seeds
  the specified scenario.

GUARDRAILS
- PresenterKit drives via routes + shared state only; it imports no sub-app.

BEFORE YOU CODE
List the resolved routes and confirm each exists as an entry route. Wait for approval.

DEFINITION OF DONE
Script selectable in the presenter overlay; steps run start-to-finish in the Simulator.
```

---

## Template 8 — Promote a sub-app to a standalone binary

Use only when a demo's point is a genuine iOS app-to-app handoff (a real springboard
switch). This adds a second host for an existing sub-app; it does NOT modify the module,
and the shell stays the default host.

```text
GOAL
Add a standalone app target that ships Fake〈Name〉App as its own binary, reusing the
existing module unchanged, so it can participate in real iOS URL-scheme cross-linking.

WHY (confirm this is warranted)
- The demo needs a real app-switch (e.g. "tap a link in Fake Mail → Fake Chase launches"),
  NOT in-shell navigation. If in-shell is acceptable, use Template 6 instead — it's simpler
  and keeps the presenter layer.

MECHANISM (required)
- New app target Fake〈Name〉Standalone with a ~5-line @main that calls the SAME
  Fake〈Name〉Module().makeRootView(deepLink:) and injects its Theme. Do NOT fork or copy
  the module.
- Register CFBundleURLTypes → 〈fakename〉 in the standalone target's Info.plist. To open
  OTHER fake apps from it, add their schemes under LSApplicationQueriesSchemes.
- Cross-app opens use the SAME DemoRoute: UIApplication.open(route.url). Parse the inbound
  URL back into a DemoRoute via DemoRoute(_:) and pass it as the deepLink.

ACCEPTANCE CRITERIA (Given / When / Then)
- Given the standalone target, when built and installed on the Simulator, then it launches
  straight into Fake〈Name〉App in its theme (light + dark).
- Given another installed app calls open(〈fakename〉://〈path〉), when invoked, then iOS
  switches to this binary and it deep-links to 〈that screen〉.
- Given the module source, when compared, then it is byte-for-byte the same code the shell
  hosts (no fork, no #if per-host branching in screens).
- Given the shell build, when run, then Fake〈Name〉App still works in-process exactly as
  before (this change is additive).

NON-GOALS / TRADE-OFFS TO STATE BACK TO ME
- The presenter control layer, shared live state, live theme switch, and seamless
  transitions do NOT cross the process boundary. Confirm you understand the standalone
  binary loses these, and that the shell remains the primary host.

GUARDRAILS
- Additive only: no changes to the module, to Core, or to the shell's hosting of it.
- Same DemoRoute addressing for both hosts — introduce no parallel routing scheme.

BEFORE YOU CODE
Restate the plan: the new target, the @main wrapper, the Info.plist scheme(s), and the
inbound-URL → DemoRoute → deepLink path. Confirm the trade-offs above. Wait for approval.

DEFINITION OF DONE
Standalone binary builds/installs/launches in the Simulator; inbound 〈fakename〉:// deep
links resolve to the right screen; the shell still hosts the same module in-process
unchanged. Give verification steps for both hosts.
```

---

## Worked example (Template 1 filled in)

A reference for the level of specificity that gets a good result:

```text
GOAL
Add a new fake app: "Fake Chase" as Packages/Features/FakeChaseApp, self-registering via
a DemoManifest.

CONTEXT
- Mimics: the Chase mobile banking app.
- Theme: new brand theme ChaseTheme (do Template 4 first: accent #117ACA light / #4DA2E8
  dark, conservative 6pt radius).
- Route scheme: fakechase://
- Apple archetype for structure: Settings-style grouped List for accounts + a push flow
  for transfers.

USER STORY
As a demo presenter, I want to walk through viewing a checking account and completing a
transfer so that stakeholders see the end-to-end money-movement experience.

SCOPE
1. Accounts (fakechase://accounts): grouped list of accounts using DesignSystem rows;
   balance header.
2. Account detail (fakechase://accounts/checking): transaction list (MediaRow-style),
   "Transfer" button.
3. Transfer flow (fakechase://accounts/checking/transfer): amount entry → review →
   Face ID confirm (SystemChrome) → success.

NON-GOALS
- No real banking, network, or payment. Mock-first only. No real biometrics.

DATA
- AccountServicing (protocol) + MockAccountService via ScenarioKit fixtures.
  Personas: "healthy balance", "overdrawn".

ENTRY ROUTES
- fakechase://accounts, fakechase://accounts/checking/transfer

ACCEPTANCE CRITERIA
- Given the catalog loads, then "Fake Chase" appears with no shell edits.
- Given I open it, then the accounts list renders in ChaseTheme, light and dark.
- Given the transfer review screen, when I confirm, then a fake Face ID overlay
  (Apple-styled) appears and, on simulated success, shows a confirmation.
- Given a deep link to fakechase://accounts/checking/transfer, then it opens on the
  transfer flow.

GUARDRAILS
- Depend only on Core; no sub-app imports. Theme-driven styling only. Face ID is fake
  (no LocalAuthentication).

BEFORE YOU CODE
Restate the plan (package, manifest, 3 screens, AccountServicing protocol, entry routes,
Face ID via SystemUIPresenting). Wait for approval.

DEFINITION OF DONE
Builds/runs in Simulator; self-registers; all criteria pass in light + dark; entry routes
resolve; no sub-app→sub-app imports.
```

---

See **[CLAUDE.md](../CLAUDE.md)** for the binding rules, **[ARCHITECTURE.md](../ARCHITECTURE.md)**
for the diagrams, and **[BUILD_PLAN.md](BUILD_PLAN.md)** for the SPM layout and contracts.
