# Build Plan

A phased implementation plan for the shell demo app, with the SPM package layout and the
load-bearing contract sketches. Hand this to Claude Code in Xcode on your Mac and build
in the order below — each phase is independently runnable in the Simulator.

> These Swift sketches define the ~6 protocols everything hangs off of. They are
> **reference shapes**, not finished code — expand and verify them in Xcode against the
> Simulator. Keep the signatures stable; that is what keeps the modules coherent.

---

## 1. SPM package layout

A single Xcode project with an app target that depends on local packages. One package per
module; sub-apps are packages too.

```
ShellDemoApp/
├─ ShellDemoApp.xcodeproj          # app target: @main, catalog, host, presenter overlay
├─ Packages/
│  ├─ DemoKit/                     # DemoModule, DemoRegistry, Manifest
│  ├─ Navigation/                  # DemoRoute, Router (two-tier), route registry
│  ├─ DesignSystem/                # Tokens, Theme protocol + themes, components, MediaUI
│  ├─ PrototypeKit/                # fake app-level flows, simulated states, haptics
│  ├─ SystemChrome/                # fake iOS system surfaces (Face ID, Apple Pay/IAP, alerts, launch)
│  ├─ CoreServices/                # service protocols + mock implementations
│  ├─ ScenarioKit/                 # named personas / fixture seeding
│  ├─ PresenterKit/                # presenter overlay (command palette, scripts, controls)
│  └─ Features/
│     ├─ FakeSettingsApp/
│     ├─ FakeMusicApp/
│     ├─ FakeTVApp/
│     ├─ FakeChaseApp/
│     ├─ FakeGoogleApp/
│     ├─ FakeDisneyApp/
│     └─ ComponentGallery/
└─ README.md
```

**Package dependency rules (enforce in each `Package.swift`):**

| Package | May depend on |
|---------|---------------|
| `DemoKit` | `Navigation` |
| `Navigation` | — (leaf) |
| `DesignSystem` | — (leaf) |
| `CoreServices` | — (leaf) |
| `ScenarioKit` | `CoreServices` |
| `PrototypeKit` | `DesignSystem` |
| `SystemChrome` | `DesignSystem` |
| `PresenterKit` | `Navigation`, `DemoKit`, `DesignSystem`, `ScenarioKit` |
| `Fake*App` | `DemoKit`, `Navigation`, `DesignSystem`, `PrototypeKit`, `SystemChrome`, `CoreServices`, `ScenarioKit` |
| `ComponentGallery` | `DesignSystem` |
| **`Fake*App` → another `Fake*App`** | ❌ **never** |

The app target depends on everything and wires the registry together.

---

## 2. Load-bearing contracts

### 2.1 `DemoRoute` — serializable, addressable navigation (Navigation)

```swift
/// A URL-like address for any screen in any sub-app. The spine of the whole design.
/// Serializable so the presenter console, scripted demos, and deep links can all
/// express a destination as data.
public struct DemoRoute: Hashable, Codable, Sendable {
    public let app: String          // e.g. "fakemusic"
    public let path: [String]       // e.g. ["library", "playlist", "42"]

    public init(app: String, path: [String]) {
        self.app = app
        self.path = path
    }

    // fakemusic://library/playlist/42
    public var url: URL { URL(string: "\(app)://\(path.joined(separator: "/"))")! }
    public init?(_ url: URL) { /* parse scheme + path */ }
}
```

### 2.2 `Router` — two-tier navigation (Navigation)

```swift
/// Root router: shell ↔ sub-apps and cross-app jumps.
@MainActor
public final class RootRouter: ObservableObject {
    @Published public var activeApp: String?            // which sub-app is on screen
    @Published public var pendingDeepLink: DemoRoute?   // consumed by the sub-app's local router

    private var registry: [String: any DemoModule] = [:]

    public func register(_ module: any DemoModule) { registry[module.manifest.id] = module }

    /// Cross-app / presenter entry point. Resolves the owner by route identity —
    /// the caller never imports the target sub-app.
    public func navigate(to route: DemoRoute) {
        guard registry[route.app] != nil else { return }
        activeApp = route.app
        pendingDeepLink = route
    }
}

/// Local router: screen ↔ screen inside one sub-app. Each sub-app owns its own.
@MainActor
public final class LocalRouter: ObservableObject {
    @Published public var path = NavigationPath()
    public func restore(to route: DemoRoute) { /* rebuild path from route.path */ }
}
```

### 2.3 `DemoModule` + `Manifest` — self-registration (DemoKit)

```swift
/// Metadata every sub-app publishes. The shell builds the catalog and the presenter
/// palette from these — adding a sub-app never edits shell code.
public struct DemoManifest: Identifiable, Sendable {
    public let id: String            // "fakemusic" — matches DemoRoute.app
    public let displayName: String   // "Fake Music"
    public let systemImage: String   // SF Symbol for the catalog row
    public let theme: ThemeID        // which Theme this sub-app roots
    public let entryRoutes: [DemoRoute]  // named deep-link entry points (for cross-links/presenter)
    public let scenarios: [ScenarioID]   // personas this sub-app supports
}

/// The contract each sub-app conforms to. It hands the shell a root view and nothing else,
/// so it may root any internal navigation style (NavigationStack, TabView, …).
@MainActor
public protocol DemoModule {
    var manifest: DemoManifest { get }
    func makeRootView(deepLink: DemoRoute?) -> AnyView
}
```

### 2.4 `Theme` + tokens — one library, many brands (DesignSystem)

```swift
public enum ThemeID: String, CaseIterable, Sendable { case apple, chase, google, disney }

/// Semantic token roles. Components read these — never literal colors — so a brand
/// skins the shared native components by remapping tokens.
public protocol Theme: Sendable {
    var id: ThemeID { get }
    // color roles (each theme provides light + dark)
    var accent: Color { get }
    var background: Color { get }
    var secondaryBackground: Color { get }
    var label: Color { get }
    var separator: Color { get }
    // shape / type / motion
    var cornerRadius: CGFloat { get }
    var titleFont: Font { get }
    var bodyFont: Font { get }
    var motion: Animation { get }
}

/// Apple maps tokens straight to system semantics → free dark mode.
public struct AppleTheme: Theme {
    public let id: ThemeID = .apple
    public var accent = Color.accentColor
    public var background = Color(.systemBackground)
    public var secondaryBackground = Color(.secondarySystemBackground)
    public var label = Color(.label)
    public var separator = Color(.separator)
    public var cornerRadius: CGFloat = 10
    public var titleFont = Font.headline
    public var bodyFont = Font.body
    public var motion = Animation.default
}

/// Brand themes map tokens to brand values with explicit light/dark.
public struct ChaseTheme: Theme { /* bank blue, conservative radii, brand type */ }

/// Inject via environment; components read it.
private struct ThemeKey: EnvironmentKey { static let defaultValue: any Theme = AppleTheme() }
public extension EnvironmentValues {
    var theme: any Theme {
        get { self[ThemeKey.self] } set { self[ThemeKey.self] = newValue }
    }
}
```

### 2.5 Service protocol — mock-first, real later (CoreServices)

```swift
/// Sub-apps depend on the protocol, not the implementation. Swap Mock → Live with
/// zero UI changes.
public protocol AccountServicing: Sendable {
    func accounts() async -> [Account]
    func transactions(for id: Account.ID) async -> [Transaction]
}

public struct MockAccountService: AccountServicing {
    let persona: ScenarioID                     // chosen by ScenarioKit
    public func accounts() async -> [Account] { Fixtures.accounts(persona) }
    public func transactions(for id: Account.ID) async -> [Transaction] { Fixtures.txns(persona, id) }
}
// LiveAccountService: AccountServicing — added later, hits a real API.
```

### 2.6 Presenter command (PresenterKit)

```swift
/// A scripted demo is just an ordered list of steps — each a destination + optional state.
public struct DemoStep: Codable, Sendable {
    public let route: DemoRoute
    public let scenario: ScenarioID?
    public let theme: ThemeID?
    public let note: String?           // presenter teleprompter line
}
public struct DemoScript: Codable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let steps: [DemoStep]
}
// The overlay drives RootRouter.navigate(to:) + ScenarioKit + theme env for each step.
```

### 2.7 System surfaces — fake iOS chrome (SystemChrome)

```swift
/// Fake iOS *system* surfaces, presented above the app by the shell. Any sub-app can
/// await a simulated result. ALWAYS Apple-styled (system semantics), even inside a
/// brand-themed app — because on a real device the system UI ignores the app's brand.
///
/// GUARDRAIL: non-functional simulations only. Never wire to real LocalAuthentication,
/// StoreKit, or any backend that collects credentials, biometrics, or payment.
@MainActor
public protocol SystemUIPresenting: Sendable {
    func authenticate(reason: String) async -> BiometricResult          // Face ID / Touch ID
    func requestPurchase(_ product: FakeProduct) async -> PurchaseResult // Apple Pay / IAP sheet
    func confirm(_ alert: SystemAlert) async -> AlertResponse            // alert / action sheet
    func requestPermission(_ kind: SystemPermission) async -> Bool       // notifications, ATT, camera…
    func banner(_ banner: SystemBanner)                                  // fire-and-forget notification banner
    func playLaunch(_ manifest: DemoManifest) async                      // splash + icon-zoom open animation
}

public enum BiometricResult: Sendable { case success, failed, fallbackToPasscode, unavailable }
public enum PurchaseResult: Sendable { case purchased, cancelled, declined }
public enum SystemPermission: Sendable { case notifications, appTracking, camera, location, contacts, photos }

// Usage inside a sub-app — reads like the real thing, but the result is faked:
//   let result = await system.authenticate(reason: "Confirm transfer")
//   guard result == .success else { return }
```

The shell hosts a single `SystemUIPresenting` implementation and injects it via
`@Environment`; the overlay renders at the top window level, above the active sub-app.
`playLaunch` is invoked by the shell when entering a sub-app, using the manifest's icon +
theme to animate the "app opening" transition.

---

## 3. Phased build order

Each phase ends with something runnable in the Simulator.

| Phase | Deliverable | Proves |
|-------|-------------|--------|
| **0 — Skeleton** | Xcode project, app target, empty `DesignSystem` + `Navigation` packages | Project builds & launches |
| **1 — Foundations** | `DesignSystem` tokens + `AppleTheme` + a few native components; `Navigation` `DemoRoute` + routers | Themed components render |
| **2 — Registry & catalog** | `DemoKit` (`DemoModule`, `DemoManifest`, `DemoRegistry`); shell catalog list | Catalog lists registered sub-apps |
| **3 — First sub-app** | `FakeSettingsApp` (simplest: `NavigationStack` + `Form`) self-registers | End-to-end launch of a sub-app |
| **4 — Theming** | Add `ChaseTheme` + `FakeChaseApp` (balance header, account cards, transaction list) | One component library, two brands |
| **5 — MediaUI** | `DesignSystem.MediaUI` (`ContentShelf`, `ArtworkCard`, `HeroBanner`, `NowPlayingBar`); `FakeMusicApp` (`TabView` + persistent mini-player) + `FakeTVApp` | Shared media components across two sub-apps |
| **6 — Cross-linking** | Wire cross-app navigation (e.g. Fake TV track → Fake Music player) via `RootRouter` | Launch X from Y with no import |
| **7 — Services & scenarios** | `CoreServices` protocols + mocks; `ScenarioKit` personas | Mock-first seam; swap personas live |
| **8 — System fidelity** | `SystemChrome`: Face ID overlay, Apple Pay/IAP sheet, system alerts & permission prompts, launch animation; wire `await` calls into a sub-app (e.g. Fake Chase transfer → Face ID) | Prototypes feel like real installed apps |
| **9 — More brands** | `FakeGoogleApp`, `FakeDisneyApp`, `ComponentGallery` | Unlimited themes, one library |
| **10 — Presenter layer** | `PresenterKit` overlay: command palette, scripted runs, theme/scenario/reset; multi-trigger invocation | Drive everything from outside the sub-apps |
| **11 — PrototypeKit polish** | Fake app-level flows, simulated loading, canned transitions, haptics | Experiences *feel* real |

**Why this order:** Foundations and the registry come first because everything depends on
them. Fake Settings is the simplest sub-app, so it validates the end-to-end path cheaply.
Theming and MediaUI are introduced against real sub-apps so reuse is proven, not assumed.
The presenter layer comes late because it drives the routes and state that earlier phases
establish.

---

## 4. Conventions

- **SwiftUI + HIG first.** Native containers (`NavigationStack`, `TabView`, `List`,
  `Form`, `.sheet`, `.searchable`, `.swipeActions`, `.refreshable`). SF Symbols for Apple
  themes; brand marks for brand themes.
- **No hardcoded colors/fonts in components** — always read from `@Environment(\.theme)`.
- **No cross-feature imports** — cross-app navigation is a `DemoRoute`, never a type.
- **Services behind protocols** — UI depends on the protocol; mock today, live later.
- **Routes and state are data** — anything you can navigate to, you can name, script,
  deep-link, and test.
- **Simulator-first** — no device-only APIs in the core path; haptics are enhancement-only.

See **[../ARCHITECTURE.md](../ARCHITECTURE.md)** for the diagrams and rationale.
