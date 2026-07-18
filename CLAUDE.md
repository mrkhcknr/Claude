# CLAUDE.md

Guidance for Claude Code working in this repository. This is a modular iOS **shell app**
that hosts multiple self-contained **fake app experiences** for high-fidelity wireframe
prototyping. Read **[ARCHITECTURE.md](ARCHITECTURE.md)** and
**[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md)** before making structural changes.

## What this app is

- A **shell** with a navigable catalog of **fake apps** (sub-apps): Fake Settings, Music,
  TV, Chase, Google, Disney, …
- Each fake app demonstrates an *experience* with **interactive-but-fake UI** — it does
  **not** deliver real functionality (yet). Real functionality layers in later behind
  existing service protocols.
- Built with **SwiftUI**, adhering to **Apple HIG**, so the fake apps look and feel
  shipped — including brand skins for non-Apple apps.
- **Simulator-first.** No device-only APIs in the core path.

## Architecture rules (do not violate)

1. **Modular by SPM package.** Every module and sub-app is its own local package. Respect
   the dependency table in `docs/BUILD_PLAN.md`.
2. **Sub-apps never import other sub-apps.** Cross-app navigation goes through the
   `RootRouter` by `DemoRoute` identity — never a direct type reference.
3. **Sub-apps depend only on Core** (`DemoKit`, `Navigation`, `DesignSystem`,
   `PrototypeKit`, `SystemChrome`, `CoreServices`, `ScenarioKit`).
4. **Components are theme-driven.** No hardcoded colors or fonts in `DesignSystem`
   components — read semantic tokens from `@Environment(\.theme)`. Adding a brand = adding
   one `Theme`, with **no component changes**.
5. **Navigation is declarative data.** Every screen is addressable as a serializable
   `DemoRoute`. This is what powers cross-links, the presenter palette, scripted demos,
   and deep links.
6. **Services are mock-first behind protocols.** UI depends on the protocol; `Mock*`
   implementations use `ScenarioKit` fixtures today, `Live*` implementations arrive later
   with zero UI changes.
7. **Sub-apps self-register** via a `DemoManifest`. The shell builds its catalog and the
   presenter palette from the registry — adding a sub-app must **not** edit shell code.
8. **PresenterKit stays outside the sub-apps.** It drives them via the Router and shared
   state only; it imports no sub-app.
9. **SystemChrome is Apple-styled and always fake.** Fake iOS system surfaces (Face ID,
   Apple Pay/IAP, alerts, permission prompts, launch animations) render with system
   semantics regardless of the sub-app's brand theme. They are non-functional simulations:
   **never** wire them to real `LocalAuthentication`, `StoreKit`, or any backend that
   collects credentials, biometrics, or payment.

## Conventions

- Prefer native SwiftUI containers: `NavigationStack`, `TabView`, `List`, `Form`,
  `.sheet`, `.confirmationDialog`, `.searchable`, `.swipeActions`, `.refreshable`.
- SF Symbols for Apple-themed apps; bundled brand marks for brand themes.
- Use system semantic colors via `AppleTheme`; brand themes define **explicit light + dark**.
- Keep haptics and other device-only niceties as **enhancements only** — never the sole
  signal for an interaction (they are silent no-ops in the Simulator).
- Give the presenter overlay **multiple invocation triggers** (hidden corner tap +
  keyboard shortcut + shake) for Simulator + device reliability.

## Adding a new fake app (checklist)

1. Create `Packages/Features/Fake<Name>App` (depends only on Core).
2. Define its `DemoManifest` (`id` matches the `DemoRoute` scheme, e.g. `fakefoo`).
3. Implement `DemoModule.makeRootView(deepLink:)` — root your own `NavigationStack` or
   `TabView` and own a `LocalRouter`.
4. Reuse `DesignSystem` components; pick or add a `Theme`.
5. Depend on service **protocols** from `CoreServices`; back them with `Mock*` +
   `ScenarioKit` fixtures.
6. Register the module with the app target's registry. **Do not edit the shell catalog.**
7. Declare `entryRoutes` for any screens other apps or the presenter should deep-link to.

## Verifying changes

- Build and run in the **iOS Simulator** (Xcode) — this is the primary verification path.
- Use Xcode **Environment Overrides** to check light/dark, Dynamic Type, and accessibility
  against the theme system.
- For a UI change, drive the actual flow in the Simulator, not just a preview.

## Build order

Follow the phased plan in `docs/BUILD_PLAN.md` (Foundations → Registry → first sub-app →
theming → MediaUI → cross-linking → services → more brands → presenter → polish). Each
phase should end runnable in the Simulator.
