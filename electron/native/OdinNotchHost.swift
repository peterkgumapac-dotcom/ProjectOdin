import AppKit
import Foundation
import SwiftUI
import WebKit

struct LaunchOptions {
    var url: URL
    var width: CGFloat = 44
    var height: CGFloat = 44
    var sessionPath: String?
}

struct NotchGeometry: Codable, CustomStringConvertible {
    let notchX: CGFloat
    let notchY: CGFloat
    let notchWidth: CGFloat
    let notchHeight: CGFloat
    let leftSafeWidth: CGFloat
    let rightSafeWidth: CGFloat
    let menuBarHeight: CGFloat
    let screenWidth: CGFloat
    let screenHeight: CGFloat
    let hasNotch: Bool

    var description: String {
        "NotchGeometry(notchX: \(notchX), notchY: \(notchY), notchWidth: \(notchWidth), notchHeight: \(notchHeight), leftSafeWidth: \(leftSafeWidth), rightSafeWidth: \(rightSafeWidth), menuBarHeight: \(menuBarHeight), screenWidth: \(screenWidth), screenHeight: \(screenHeight), hasNotch: \(hasNotch))"
    }

    static func current(for screen: NSScreen) -> NotchGeometry {
        let inset = screen.safeAreaInsets.top
        let leftArea = screen.auxiliaryTopLeftArea ?? .zero
        let rightArea = screen.auxiliaryTopRightArea ?? .zero
        let notchWidth = inset > 0
            ? screen.frame.width - leftArea.width - rightArea.width
            : 0
        let notchX = inset > 0 ? screen.frame.minX + leftArea.width : screen.frame.midX
        return NotchGeometry(
            notchX: notchX,
            notchY: 0,
            notchWidth: notchWidth,
            notchHeight: inset,
            leftSafeWidth: leftArea.width,
            rightSafeWidth: rightArea.width,
            menuBarHeight: max(inset, NSStatusBar.system.thickness),
            screenWidth: screen.frame.width,
            screenHeight: screen.frame.height,
            hasNotch: inset > 0
        )
    }
}

struct OdinNotchSettings {
    var compactEnabled: Bool = true
    var hoverExpandEnabled: Bool = true
    var hoverIntentDelayMs: Int = 200
    var collapseDelayMs: Int = 550
    var expandedWidthMode: String = "auto"
    var quickApps: [String] = []
    var headerRightMode: String = "health-strip"
}

private func parseLaunchOptions() -> LaunchOptions? {
    let arguments = CommandLine.arguments
    guard let urlIndex = arguments.firstIndex(of: "--url"),
          arguments.indices.contains(urlIndex + 1),
          let url = URL(string: arguments[urlIndex + 1]) else {
        return nil
    }

    var options = LaunchOptions(url: url)
    if let widthIndex = arguments.firstIndex(of: "--width"),
       arguments.indices.contains(widthIndex + 1),
       let width = Double(arguments[widthIndex + 1]) {
        options.width = CGFloat(width)
    }
    if let heightIndex = arguments.firstIndex(of: "--height"),
       arguments.indices.contains(heightIndex + 1),
       let height = Double(arguments[heightIndex + 1]) {
        options.height = CGFloat(height)
    }
    if let sessionPathIndex = arguments.firstIndex(of: "--session-path"),
       arguments.indices.contains(sessionPathIndex + 1) {
        options.sessionPath = arguments[sessionPathIndex + 1]
    }
    return options
}

final class HoverTrackingView: NSView {
    var onHoverChanged: ((Bool) -> Void)?
    private var trackingAreaRef: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingAreaRef {
            removeTrackingArea(trackingAreaRef)
        }
        let options: NSTrackingArea.Options = [
            .mouseEnteredAndExited,
            .activeAlways,
            .inVisibleRect,
        ]
        let next = NSTrackingArea(rect: bounds, options: options, owner: self, userInfo: nil)
        addTrackingArea(next)
        trackingAreaRef = next
    }

    override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        onHoverChanged?(true)
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        onHoverChanged?(false)
    }
}

final class ExpandedNotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class OdinNotchHost: NSObject, NSApplicationDelegate, WKNavigationDelegate, NotchMessageHandling {
    private let options: LaunchOptions
    private let settings = OdinNotchSettings()

    private var compactPanel: NSPanel?
    private var expandedPanel: NSPanel?
    private var compactTrackingView: HoverTrackingView?
    private var compactHostingView: NSHostingView<CompactNotchView>?
    private var expandedTrackingView: HoverTrackingView?
    private var webView: WKWebView?
    private var fallbackOverlay: NSView?
    private var fallbackLabel: NSTextField?
    private var messageHandler: NotchMessageHandler?

    private var outsideMouseMonitor: Any?
    private var outsideMouseLocalMonitor: Any?
    private var sessionRefreshTimer: Timer?
    private var hoverIntentWorkItem: DispatchWorkItem?
    private var collapseWorkItem: DispatchWorkItem?

    private var expandedDetailMode = false
    private var didReceiveTrayReady = false
    private var didFinishLastNavigation = false
    private var hasRetriedWebViewLoad = false
    private var lastSessionJSON: String?
    private weak var priorKeyWindow: NSWindow?
    private var priorActivationPolicy: NSApplication.ActivationPolicy?
    private var priorFrontmostApplication: NSRunningApplication?
    private var compactMode: NotchMode = .resting
    private var lastCompactModeBeforeExpand: NotchMode = .resting
    private var compactTitle: String = "ODIN"
    private var compactSubtitle: String = "Ready"
    private var compactDetail: String = ""
    private var compactArtworkUrl: String = ""
    private var compactProgress: Double = 0
    private var compactIsPlaying: Bool = false
    private var compactActionLabel: String = ""
    private var compactDays: [CompactNotchDay] = []

    // Explicit state machine flags
    private var compactVisible = false
    private var hoverIntentPending = false
    private var expandedVisible = false
    private var collapsePending = false

    private let expandedMinWidth: CGFloat = 880
    private let expandedMaxWidth: CGFloat = 1180
    private let expandedWidthRatio: CGFloat = 0.56
    private let expandedOverviewHeight: CGFloat = 256
    private let expandedDetailHeight: CGFloat = 300
    private let animationDuration: TimeInterval = 0.24
    private let diagLogMaxBytes: UInt64 = 256 * 1024

    init(options: LaunchOptions) {
        self.options = options
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        createCompactPanel()
        installOutsideClickMonitor()
        startSessionRefreshMonitor()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenParametersDidChange),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let outsideMouseMonitor {
            NSEvent.removeMonitor(outsideMouseMonitor)
        }
        if let outsideMouseLocalMonitor {
            NSEvent.removeMonitor(outsideMouseLocalMonitor)
        }
        hoverIntentWorkItem?.cancel()
        collapseWorkItem?.cancel()
        sessionRefreshTimer?.invalidate()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "odin")
    }

    @objc private func screenParametersDidChange() {
        refreshPanelGeometry(reason: "screen-change", animated: false)
    }

    private func createCompactPanel() {
        guard let screen = targetScreen(), let geometry = geometry(for: screen) else { return }
        let frame = compactFrame(for: screen, geometry: geometry)

        let panel = NSPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "ODIN Compact Notch"
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.isMovable = false
        panel.ignoresMouseEvents = false
        panel.acceptsMouseMovedEvents = true

        let trackingView = HoverTrackingView(frame: NSRect(origin: .zero, size: frame.size))
        trackingView.wantsLayer = true
        trackingView.layer?.backgroundColor = NSColor.clear.cgColor
        trackingView.onHoverChanged = { [weak self] inside in
            self?.handleCompactHover(inside: inside)
        }

        let hosting = NSHostingView(rootView: makeCompactView(geometry: geometry))
        hosting.frame = trackingView.bounds
        hosting.autoresizingMask = [.width, .height]
        hosting.wantsLayer = true
        hosting.layer?.backgroundColor = NSColor.clear.cgColor
        let click = NSClickGestureRecognizer(target: self, action: #selector(handleCompactClick))
        hosting.addGestureRecognizer(click)
        trackingView.addSubview(hosting)

        panel.contentView = trackingView
        panel.orderFrontRegardless()

        compactPanel = panel
        compactTrackingView = trackingView
        compactHostingView = hosting
        compactVisible = true

        emitNotchGeometry(reason: "launch")
    }

    private func createExpandedPanelIfNeeded() {
        if expandedPanel != nil { return }
        guard let screen = targetScreen(), let notchGeometry = geometry(for: screen) else { return }
        let frame = expandedFrame(for: screen, geometry: notchGeometry)

        let panel = ExpandedNotchPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "ODIN Expanded Notch"
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.isMovable = false
        panel.ignoresMouseEvents = false
        panel.acceptsMouseMovedEvents = true

        let container = HoverTrackingView(frame: NSRect(origin: .zero, size: frame.size))
        container.autoresizingMask = [.width, .height]
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.black.cgColor
        container.layer?.cornerRadius = 18
        if #available(macOS 10.13, *) {
            container.layer?.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        }
        container.layer?.masksToBounds = true
        container.onHoverChanged = { [weak self] inside in
            self?.handleExpandedHover(inside: inside)
        }

        let nextWebView = makeTrayWebView(frame: container.bounds)
        nextWebView.autoresizingMask = [.width, .height]
        container.addSubview(nextWebView)

        let overlay = makeFallbackOverlay(frame: container.bounds)
        overlay.autoresizingMask = [.width, .height]
        container.addSubview(overlay)

        panel.contentView = container
        panel.orderOut(nil)

        expandedPanel = panel
        expandedTrackingView = container
        webView = nextWebView
        fallbackOverlay = overlay

        showFallback("Loading ODIN tray...")
        nextWebView.load(URLRequest(url: options.url))
    }

    private func makeTrayWebView(frame: NSRect) -> WKWebView {
        let initialSessionJSON = AuthBridge.readSessionJSON(at: options.sessionPath)
        lastSessionJSON = initialSessionJSON

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        if options.url.host == "localhost" || options.url.host == "127.0.0.1" {
            configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }

        let userContentController = WKUserContentController()
        userContentController.addUserScript(AuthBridge.authInjectionScript(sessionJSON: initialSessionJSON))
        userContentController.addUserScript(
            WKUserScript(
                source: OdinNotchHost.notchBridgeScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false
            )
        )
        userContentController.addUserScript(
            WKUserScript(
                source: OdinNotchHost.notchProbeScript,
                injectionTime: .atDocumentEnd,
                forMainFrameOnly: false
            )
        )
        let handler = NotchMessageHandler(delegate: self)
        userContentController.add(handler, name: "odin")
        configuration.userContentController = userContentController
        messageHandler = handler

        let web = WKWebView(frame: frame, configuration: configuration)
        web.navigationDelegate = self
        web.underPageBackgroundColor = .clear
        web.wantsLayer = true
        web.layer?.backgroundColor = NSColor.black.cgColor
        web.layer?.isOpaque = false
        web.setValue(false, forKey: "drawsBackground")
        web.allowsBackForwardNavigationGestures = false
        return web
    }

    private func makeFallbackOverlay(frame: NSRect) -> NSView {
        let overlay = NSView(frame: frame)
        overlay.wantsLayer = true
        overlay.layer?.backgroundColor = NSColor(calibratedWhite: 0.03, alpha: 0.98).cgColor

        let label = NSTextField(labelWithString: "Loading ODIN tray...")
        label.alignment = .center
        label.textColor = NSColor(white: 0.92, alpha: 1.0)
        label.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        label.frame = NSRect(x: 16, y: frame.height / 2 - 16, width: max(220, frame.width - 32), height: 20)
        label.autoresizingMask = [.width, .minYMargin, .maxYMargin]
        overlay.addSubview(label)

        let button = NSButton(title: "Retry", target: self, action: #selector(handleFallbackRetry))
        button.bezelStyle = .rounded
        button.frame = NSRect(x: (frame.width - 96) / 2, y: max(18, frame.height / 2 - 50), width: 96, height: 28)
        button.autoresizingMask = [.minXMargin, .maxXMargin, .maxYMargin]
        overlay.addSubview(button)

        fallbackLabel = label
        overlay.isHidden = true
        return overlay
    }

    @objc private func handleCompactClick() {
        expandFromNative(reason: "compact-click")
    }

    @objc private func handleFallbackRetry() {
        hasRetriedWebViewLoad = false
        showFallback("Retrying ODIN tray...")
        webView?.reload()
    }

    private func handleCompactHover(inside: Bool) {
        guard settings.hoverExpandEnabled else { return }
        if inside {
            scheduleHoverIntentExpand()
        } else {
            cancelHoverIntentExpand()
            if compactMode == .musicPeek {
                scheduleCollapse(reason: "compact-peek-exit")
            }
        }
    }

    private func handleExpandedHover(inside: Bool) {
        if inside {
            cancelScheduledCollapse()
        } else {
            scheduleCollapse(reason: "expanded-hover-exit")
        }
    }

    private func scheduleHoverIntentExpand() {
        guard !expandedVisible else { return }
        cancelScheduledCollapse()
        hoverIntentWorkItem?.cancel()
        hoverIntentPending = true

        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.hoverIntentPending = false
            if self.compactMode == .music {
                self.compactMode = .musicPeek
                self.refreshPanelGeometry(reason: "music-peek", animated: true)
            } else {
                self.expandFromNative(reason: "hover-intent")
            }
        }
        hoverIntentWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + TimeInterval(settings.hoverIntentDelayMs) / 1000.0, execute: work)
    }

    private func cancelHoverIntentExpand() {
        hoverIntentWorkItem?.cancel()
        hoverIntentWorkItem = nil
        hoverIntentPending = false
    }

    private func scheduleCollapse(reason: String) {
        guard expandedVisible || compactMode == .musicPeek else { return }
        cancelScheduledCollapse()
        collapsePending = true
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.collapsePending = false
            if self.expandedVisible {
                self.collapseToCompact(reason: reason)
            } else if self.compactMode == .musicPeek {
                self.compactMode = .music
                self.refreshPanelGeometry(reason: reason, animated: true)
            }
        }
        collapseWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + TimeInterval(settings.collapseDelayMs) / 1000.0, execute: work)
    }

    private func cancelScheduledCollapse() {
        collapseWorkItem?.cancel()
        collapseWorkItem = nil
        collapsePending = false
    }

    private func expandFromNative(reason: String) {
        guard settings.compactEnabled else { return }
        cancelHoverIntentExpand()
        cancelScheduledCollapse()
        createExpandedPanelIfNeeded()

        guard let expandedPanel, let compactPanel, let screen = targetScreen(), let notchGeometry = geometry(for: screen) else { return }
        let frame = expandedFrame(for: screen, geometry: notchGeometry)
        expandedPanel.setFrame(frame, display: true)

        compactPanel.orderOut(nil)
        compactVisible = false
        if compactMode != .fullAccess {
            lastCompactModeBeforeExpand = compactMode == .musicPeek ? .music : compactMode
        }
        compactMode = .fullAccess

        priorKeyWindow = NSApp.keyWindow
        priorActivationPolicy = NSApp.activationPolicy()
        priorFrontmostApplication = NSWorkspace.shared.frontmostApplication
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        expandedPanel.alphaValue = 0
        expandedPanel.makeKeyAndOrderFront(nil)
        logActivationState(tag: "ODIN_EXPAND_STATE_C_IMMEDIATE")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.logActivationState(tag: "ODIN_EXPAND_STATE_C_200MS")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            self?.logActivationState(tag: "ODIN_EXPAND_STATE_C_1200MS")
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = animationDuration
            context.allowsImplicitAnimation = true
            expandedPanel.animator().alphaValue = 1
        }
        expandedVisible = true

        dispatchNotchEvent("notch:expanded")
        emitNotchGeometry(reason: reason)
        emitAuthSessionIfAvailable(force: true)
    }

    private func collapseToCompact(reason: String) {
        cancelHoverIntentExpand()
        cancelScheduledCollapse()
        guard let compactPanel else { return }

        expandedPanel?.orderOut(nil)
        compactMode = lastCompactModeBeforeExpand
        if let priorActivationPolicy {
            NSApp.setActivationPolicy(priorActivationPolicy)
        }
        priorActivationPolicy = nil
        priorKeyWindow?.makeKey()
        priorKeyWindow = nil
        priorFrontmostApplication?.activate(options: [])
        priorFrontmostApplication = nil
        expandedVisible = false

        if let screen = targetScreen(), let notchGeometry = geometry(for: screen) {
            let compactRect = compactFrame(for: screen, geometry: notchGeometry)
            compactPanel.setFrame(compactRect, display: true)
            compactHostingView?.rootView = makeCompactView(geometry: notchGeometry)
        }

        compactPanel.orderFrontRegardless()
        compactVisible = true

        dispatchNotchEvent("notch:collapsed")
        emitNotchGeometry(reason: reason)
    }

    private func logActivationState(tag: String) {
        let keyWindowName = NSApp.keyWindow.map { String(describing: type(of: $0)) } ?? "nil"
        let panelKey = expandedPanel?.isKeyWindow ?? false
        let panelVisible = expandedPanel?.isVisible ?? false
        let occlusion = expandedPanel?.occlusionState.rawValue ?? 0
        print("\(tag) policy=\(NSApp.activationPolicy().rawValue) panelKey=\(panelKey) panelVisible=\(panelVisible) appActive=\(NSApp.isActive) keyWindow=\(keyWindowName) occlusion=\(occlusion)")
        fflush(stdout)
    }

    private func refreshPanelGeometry(reason: String, animated: Bool) {
        guard let screen = targetScreen(), let notchGeometry = geometry(for: screen) else { return }

        if let compactPanel {
            let compactRect = compactFrame(for: screen, geometry: notchGeometry)
            if animated {
                animate(panel: compactPanel, to: compactRect)
            } else {
                compactPanel.setFrame(compactRect, display: true)
            }
            compactHostingView?.rootView = makeCompactView(geometry: notchGeometry)
        }

        if let expandedPanel {
            let nextFrame = expandedFrame(for: screen, geometry: notchGeometry)
            if animated {
                animate(panel: expandedPanel, to: nextFrame)
            } else {
                expandedPanel.setFrame(nextFrame, display: true)
            }
        }

        emitNotchGeometry(reason: reason)
    }

    private func animate(panel: NSPanel, to frame: NSRect) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = animationDuration
            context.allowsImplicitAnimation = true
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.2, 1.0)
            panel.animator().setFrame(frame, display: true)
        }
    }

    private func compactFrame(for screen: NSScreen, geometry: NotchGeometry) -> NSRect {
        let size = CompactNotchView.windowSize(for: geometry, mode: compactMode)
        let origin = CompactNotchView.windowOrigin(for: geometry, on: screen, mode: compactMode)
        return NSRect(origin: origin, size: size)
    }

    private func expandedFrame(for screen: NSScreen, geometry: NotchGeometry) -> NSRect {
        let compactWidth = CompactNotchView.windowSize(for: geometry, mode: compactMode).width
        let autoWidth = geometry.screenWidth * expandedWidthRatio
        let clampedAutoWidth = max(expandedMinWidth, min(expandedMaxWidth, autoWidth))
        let maxUsableWidth = max(compactWidth, screen.frame.width - 24)
        let width = min(max(compactWidth, clampedAutoWidth), maxUsableWidth)
        let height = expandedDetailMode ? expandedDetailHeight : expandedOverviewHeight

        let notchCenterX = geometry.notchX + (geometry.notchWidth / 2)
        var x = notchCenterX - (width / 2)
        x = max(screen.frame.minX, min(x, screen.frame.maxX - width))

        let y = screen.frame.maxY - height
        return NSRect(x: x, y: y, width: width, height: height)
    }

    private func installOutsideClickMonitor() {
        let collapseIfNeeded: () -> Void = { [weak self] in
            guard let self,
                  self.expandedVisible,
                  let expandedPanel = self.expandedPanel else {
                return
            }
            let point = NSEvent.mouseLocation
            if !expandedPanel.frame.contains(point) {
                self.collapseToCompact(reason: "outside-click")
            }
        }

        outsideMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { _ in
            collapseIfNeeded()
        }
        outsideMouseLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { event in
            collapseIfNeeded()
            return event
        }
    }

    private func showFallback(_ text: String) {
        fallbackLabel?.stringValue = text
        fallbackOverlay?.isHidden = false
    }

    private func hideFallback() {
        fallbackOverlay?.isHidden = true
    }

    private func diagLogURL() -> URL {
        let fm = FileManager.default
        if let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            return appSupport
                .appendingPathComponent("ODIN", isDirectory: true)
                .appendingPathComponent("odin-diag.log", isDirectory: false)
        }
        return URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/ODIN/odin-diag.log", isDirectory: false)
    }

    private func rotateDiagLogIfNeeded(at url: URL) {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? NSNumber else { return }
        if size.uint64Value <= diagLogMaxBytes { return }
        let rotated = URL(fileURLWithPath: "\(url.path).1")
        try? fm.removeItem(at: rotated)
        try? fm.moveItem(at: url, to: rotated)
    }

    private func appendDiagEntry(_ payload: [String: Any]) {
        let fm = FileManager.default
        let logURL = diagLogURL()
        let entry: [String: Any]
        if payload.isEmpty {
            entry = [
                "ts": ISO8601DateFormatter().string(from: Date()),
                "source": "notch",
                "message": "empty appendDiag payload",
            ]
        } else {
            entry = payload
        }

        do {
            try fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            rotateDiagLogIfNeeded(at: logURL)
            let data = try JSONSerialization.data(withJSONObject: entry, options: [])
            guard var line = String(data: data, encoding: .utf8) else { return }
            line.append("\n")

            if !fm.fileExists(atPath: logURL.path) {
                try line.write(to: logURL, atomically: true, encoding: .utf8)
                return
            }

            let handle = try FileHandle(forWritingTo: logURL)
            defer { try? handle.close() }
            try handle.seekToEnd()
            if let bytes = line.data(using: .utf8) {
                try handle.write(contentsOf: bytes)
            }
        } catch {
            fputs("ODIN_NOTCH_DIAG_APPEND_FAIL \(error.localizedDescription)\n", stderr)
        }
    }

    private func startSessionRefreshMonitor() {
        sessionRefreshTimer?.invalidate()
        sessionRefreshTimer = Timer.scheduledTimer(withTimeInterval: 4.0, repeats: true) { [weak self] _ in
            self?.emitAuthSessionIfAvailable()
        }
        if let sessionRefreshTimer {
            RunLoop.main.add(sessionRefreshTimer, forMode: .common)
        }
    }

    private func emitNotchGeometry(reason: String) {
        guard let screen = targetScreen(), let notchGeometry = geometry(for: screen) else { return }
        let encoder = JSONEncoder()
        guard let data = try? encoder.encode(notchGeometry), let json = String(data: data, encoding: .utf8) else { return }
        print("ODIN_NOTCH_GEOMETRY reason=\(reason) \(json)")
        fflush(stdout)
        dispatchNotchEvent("notch:geometry", payloadJSON: json)
    }

    private func makeCompactView(geometry: NotchGeometry) -> CompactNotchView {
        CompactNotchView(
            geometry: geometry,
            mode: compactMode,
            title: compactTitle,
            subtitle: compactSubtitle,
            detail: compactDetail,
            artworkUrl: compactArtworkUrl,
            progress: compactProgress,
            isPlaying: compactIsPlaying,
            actionLabel: compactActionLabel,
            days: compactDays
        )
    }

    private func applyCompactModePayload(_ payload: [String: Any]) {
        if let raw = payload["mode"] as? String,
           let nextMode = NotchMode(rawValue: raw),
           nextMode != .fullAccess {
            compactMode = nextMode
            lastCompactModeBeforeExpand = nextMode
        }
        if let title = (payload["title"] as? String) ?? (payload["primary"] as? String) {
            compactTitle = title
        }
        if let subtitle = (payload["subtitle"] as? String) ?? (payload["secondary"] as? String) {
            compactSubtitle = subtitle
        }
        if let detail = (payload["detail"] as? String) ?? (payload["tertiary"] as? String) {
            compactDetail = detail
        }
        if let artworkUrl = payload["artworkUrl"] as? String {
            compactArtworkUrl = artworkUrl
        }
        if let progress = payload["progress"] as? Double {
            compactProgress = min(1, max(0, progress))
        } else if let progress = payload["progress"] as? NSNumber {
            compactProgress = min(1, max(0, progress.doubleValue))
        }
        if let isPlaying = payload["isPlaying"] as? Bool {
            compactIsPlaying = isPlaying
        }
        if let actionLabel = payload["actionLabel"] as? String {
            compactActionLabel = actionLabel
        }
        if let rawDays = payload["days"] as? [[String: Any]] {
            compactDays = rawDays.compactMap { item in
                guard let label = item["label"] as? String,
                      let value = item["value"] as? String else { return nil }
                return CompactNotchDay(
                    label: label,
                    value: value,
                    selected: (item["selected"] as? Bool) ?? false
                )
            }
        }

        if !expandedVisible {
            refreshPanelGeometry(reason: "compact-mode", animated: true)
        }
    }

    private func emitAuthSessionIfAvailable(force: Bool = false) {
        guard let json = AuthBridge.readSessionJSON(at: options.sessionPath) else { return }
        if !force && json == lastSessionJSON { return }
        lastSessionJSON = json
        dispatchNotchEvent("auth:session", payloadJSON: json)
    }

    private func dispatchNotchEvent(_ eventName: String) {
        webView?.evaluateJavaScript(AuthBridge.dispatchScript(eventName: eventName))
    }

    private func dispatchNotchEvent(_ eventName: String, payloadJSON: String) {
        webView?.evaluateJavaScript(AuthBridge.dispatchScript(eventName: eventName, payloadJSON: payloadJSON))
    }

    private func emitRecentFiles() {
        let urls = Array(NSDocumentController.shared.recentDocumentURLs.prefix(10))
        let iso = ISO8601DateFormatter()
        let rows: [[String: Any]] = urls.compactMap { url in
            let values = try? url.resourceValues(forKeys: [.nameKey, .contentModificationDateKey, .contentAccessDateKey])
            let appUrl = try? NSWorkspace.shared.urlForApplication(toOpen: url)
            let appName = appUrl?.deletingPathExtension().lastPathComponent
            let modified = values?.contentAccessDate ?? values?.contentModificationDate
            return [
                "path": url.path,
                "name": values?.name ?? url.lastPathComponent,
                "appName": appName ?? "",
                "modifiedAt": modified.map { iso.string(from: $0) } ?? "",
            ]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: rows, options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        dispatchNotchEvent("quick-access:recent-files", payloadJSON: json)
    }

    private func emitInstalledApps() {
        let roots = [
            "/Applications",
            "/Applications/Utilities",
            "/System/Applications",
            "/System/Library/CoreServices",
        ]

        let priorityPaths = [
            "/Applications/Slack.app",
            "/Applications/Google Chrome.app",
            "/Applications/Safari.app",
            "/System/Library/CoreServices/Finder.app",
            "/System/Applications/Mail.app",
            "/System/Applications/Messages.app",
            "/System/Applications/Calendar.app",
            "/System/Applications/Notes.app",
            "/System/Applications/Music.app",
        ]
        let priorityOrder = Dictionary(uniqueKeysWithValues: priorityPaths.enumerated().map { ($0.element, $0.offset) })

        let fm = FileManager.default
        var rows: [[String: Any]] = []
        var seen = Set<String>()

        func appendApp(_ url: URL) {
            let path = url.path
            guard path.hasSuffix(".app"), seen.insert(path).inserted else { return }
            rows.append([
                "id": "app:\(path)",
                "label": url.deletingPathExtension().lastPathComponent,
                "path": path,
                "icon": "",
            ])
        }

        for root in roots {
            let rootURL = URL(fileURLWithPath: root, isDirectory: true)
            guard let entries = try? fm.contentsOfDirectory(
                at: rootURL,
                includingPropertiesForKeys: [.isDirectoryKey, .isApplicationKey],
                options: [.skipsHiddenFiles]
            ) else { continue }
            for url in entries {
                appendApp(url)
            }
        }

        rows.sort { lhs, rhs in
            let leftPath = lhs["path"] as? String ?? ""
            let rightPath = rhs["path"] as? String ?? ""
            let leftPriority = priorityOrder[leftPath] ?? Int.max
            let rightPriority = priorityOrder[rightPath] ?? Int.max
            if leftPriority != rightPriority { return leftPriority < rightPriority }
            let leftLabel = (lhs["label"] as? String ?? "").localizedLowercase
            let rightLabel = (rhs["label"] as? String ?? "").localizedLowercase
            return leftLabel < rightLabel
        }

        if rows.count > 80 {
            rows = Array(rows.prefix(80))
        }

        guard let data = try? JSONSerialization.data(withJSONObject: rows, options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        dispatchNotchEvent("quick-access:installed-apps", payloadJSON: json)
    }

    private func appIconDataURL(forAppPath path: String) -> String? {
        let image = NSWorkspace.shared.icon(forFile: path)
        image.size = NSSize(width: 36, height: 36)
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            return nil
        }
        return "data:image/png;base64,\(png.base64EncodedString())"
    }

    private func logNavigation(_ tag: String, webView: WKWebView, extra: String = "") {
        let currentURL = webView.url?.absoluteString ?? "<nil>"
        if extra.isEmpty {
            print("ODIN_NOTCH_NAV \(tag) url=\(currentURL)")
        } else {
            print("ODIN_NOTCH_NAV \(tag) url=\(currentURL) \(extra)")
        }
        fflush(stdout)
    }

    private func targetScreen() -> NSScreen? {
        if let notched = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) {
            return notched
        }
        return NSScreen.main ?? NSScreen.screens.first
    }

    private func geometry(for screen: NSScreen) -> NotchGeometry? {
        let result = NotchGeometry.current(for: screen)
        let leftArea = screen.auxiliaryTopLeftArea ?? .zero
        let rightArea = screen.auxiliaryTopRightArea ?? .zero
        if result.hasNotch && (result.notchWidth <= 0 || leftArea.width <= 0 || rightArea.width <= 0) {
            let raw = "safeAreaTop=\(screen.safeAreaInsets.top) leftArea=\(leftArea) rightArea=\(rightArea) frame=\(screen.frame)"
            fputs("ODIN_NOTCH_GEOMETRY_ERROR unexpected AppKit notch values \(raw)\n", stderr)
            return nil
        }
        return result
    }

    func handleNotchAction(_ action: String, payload: [String: Any]) {
        if action.hasPrefix("__") {
            let extra = payload.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
            print("ODIN_NOTCH_ACTION \(action) \(extra)")
        } else {
            print("ODIN_NOTCH_ACTION \(action)")
        }
        fflush(stdout)

        switch action {
        case "__bridge_loaded":
            // If bridge code runs, content process is alive. Unblock visual surface.
            hideFallback()
        case "openRoute":
            if let route = payload["route"] as? String {
                collapseToCompact(reason: "open-route")
                openOdinRoute(route)
            }
        case "openPath":
            if let path = payload["path"] as? String {
                openPathKey(path)
            }
        case "openFinder":
            if let target = payload["path"] as? String {
                openFinderPath(target)
            }
        case "listRecentFiles":
            emitRecentFiles()
        case "listInstalledApps":
            emitInstalledApps()
        case "voiceStart":
            collapseToCompact(reason: "voice-start")
            openOdinRoute("/dashboard?portal=open&voice=start")
        case "hoverEnter":
            // Compatibility only. Native hover tracking is now authoritative.
            scheduleHoverIntentExpand()
        case "hoverLeave":
            // Compatibility only. Native hover tracking is now authoritative.
            scheduleCollapse(reason: "bridge-hover-leave")
        case "trayReady":
            // Telemetry only. Never gates expand/collapse.
            didReceiveTrayReady = true
            hideFallback()
            emitNotchGeometry(reason: "tray-ready")
            emitAuthSessionIfAvailable(force: true)
            emitRecentFiles()
            emitInstalledApps()
        case "setCompactMode":
            applyCompactModePayload(payload)
        case "appendDiag":
            appendDiagEntry(payload)
        case "resize":
            if let mode = payload["mode"] as? String {
                expandedDetailMode = (mode == "detail")
            } else if let detail = payload["detail"] as? Bool {
                expandedDetailMode = detail
            } else {
                expandedDetailMode = false
            }
            if expandedVisible {
                refreshPanelGeometry(reason: "resize", animated: true)
            }
        default:
            break
        }
    }

    private func openPathKey(_ key: String) {
        if key.hasPrefix("/") {
            NSWorkspace.shared.open(URL(fileURLWithPath: key))
            return
        }
        let fileManager = FileManager.default
        let url: URL?
        switch key {
        case "documents":
            url = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first
        case "screenshots":
            url = fileManager.urls(for: .desktopDirectory, in: .userDomainMask).first
        case "recent", "downloads":
            url = fileManager.urls(for: .downloadsDirectory, in: .userDomainMask).first
        default:
            url = fileManager.urls(for: .downloadsDirectory, in: .userDomainMask).first
        }
        if let url {
            NSWorkspace.shared.open(url)
        }
    }

    private func openFinderPath(_ targetPath: String) {
        guard !targetPath.isEmpty else { return }
        NSWorkspace.shared.selectFile(targetPath, inFileViewerRootedAtPath: "")
    }

    private func openOdinRoute(_ route: String) {
        guard route.hasPrefix("/"), !route.hasPrefix("//") else { return }
        let encodedRoute = route.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.union(.urlQueryAllowed)) ?? "/dashboard"
        if let url = URL(string: "odin://open\(encodedRoute)") {
            NSWorkspace.shared.open(url)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        logNavigation("didStartProvisionalNavigation", webView: webView)
        didReceiveTrayReady = false
        didFinishLastNavigation = false
        showFallback("Loading ODIN tray...")
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        logNavigation("didCommit", webView: webView)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        logNavigation("didFinish", webView: webView)
        didFinishLastNavigation = true
        hasRetriedWebViewLoad = false
        hideFallback()
        emitNotchGeometry(reason: "webview-ready")
        emitAuthSessionIfAvailable(force: true)
        emitRecentFiles()
        emitInstalledApps()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleWebViewFailure(webView: webView, error: error, stage: "navigation")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleWebViewFailure(webView: webView, error: error, stage: "provisional")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        logNavigation("webContentProcessDidTerminate", webView: webView)
        fputs("ODIN_NOTCH_WEBVIEW_PROCESS_TERMINATED\n", stderr)
        showFallback("Tray process paused. Retrying...")
        webView.reload()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let requestedURL = navigationAction.request.url?.absoluteString ?? "<nil>"
        logNavigation("decidePolicyForNavigationAction", webView: webView, extra: "request=\(requestedURL)")
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if url.scheme == "odin" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let responseURL = navigationResponse.response.url?.absoluteString ?? "<nil>"
        let status: String
        if let http = navigationResponse.response as? HTTPURLResponse {
            status = String(http.statusCode)
        } else {
            status = "<non-http>"
        }
        logNavigation("decidePolicyForNavigationResponse", webView: webView, extra: "responseURL=\(responseURL) status=\(status)")
        decisionHandler(.allow)
    }

    private func handleWebViewFailure(webView: WKWebView, error: Error, stage: String) {
        let tag = stage == "provisional" ? "didFailProvisionalNavigation" : "didFailNavigation"
        logNavigation(tag, webView: webView, extra: "error=\(error.localizedDescription)")
        fputs("ODIN_NOTCH_WEBVIEW_\(stage.uppercased())_FAIL \(error.localizedDescription)\n", stderr)
        didReceiveTrayReady = false
        didFinishLastNavigation = false
        if hasRetriedWebViewLoad {
            showFallback("ODIN tray unavailable. Retry when ready.")
            return
        }
        hasRetriedWebViewLoad = true
        showFallback("Reloading ODIN tray...")
        webView.reload()
    }

    private static let notchBridgeScript = """
    (() => {
      const nativePost = (message) => {
        try {
          window.webkit.messageHandlers.odin.postMessage(message);
          return Promise.resolve(true);
        } catch (_) {
          return Promise.resolve(false);
        }
      };

      window.odin = {
        events: {
          on: (name, handler) => {
            if (typeof name !== "string" || typeof handler !== "function") return () => {};
            const wrapped = (event) => handler(event.detail);
            window.addEventListener(name, wrapped);
            return () => window.removeEventListener(name, wrapped);
          },
          off: () => {},
        },
        appendDiag: (entry) => nativePost({
          action: "appendDiag",
          payload: entry && typeof entry === "object"
            ? entry
            : {
                ts: new Date().toISOString(),
                source: "notch",
                message: String(entry ?? ""),
              },
        }),
        postMessage: (message) => nativePost(message),
      };

      try {
        window.webkit.messageHandlers.odin.postMessage({
          action: "__bridge_loaded",
          payload: { href: location.href, readyState: document.readyState },
        });
      } catch (_) {}
    })();
    """

    private static let notchProbeScript = """
    (() => {
      const fire = (tag, extra = {}) => {
        try {
          window.webkit.messageHandlers.odin.postMessage({
            action: `__probe_${tag}`,
            payload: { ts: Date.now(), ...extra },
          });
        } catch (e) {}
      };
      window.__odinFire = fire;

      fire("doc_end_inject");
      Promise.resolve().then(() => fire("microtask"));
      setTimeout(() => fire("timeout_0"), 0);
      setTimeout(() => fire("timeout_1000"), 1000);
      document.addEventListener("readystatechange", () =>
        fire("readystate", { state: document.readyState }));
      window.addEventListener("load", () =>
        fire("window_load", { rootChildren: document.getElementById("root")?.children?.length }));

      window.addEventListener("error", (event) => {
        fire("error", {
          message: String(event.message || ""),
          filename: String(event.filename || ""),
          lineno: event.lineno || 0,
          stack: event.error?.stack ? String(event.error.stack).substring(0, 1500) : "",
        });
      }, true);

      window.addEventListener("unhandledrejection", (event) => {
        fire("rejection", {
          reason: String(event.reason).substring(0, 500),
          stack: event.reason?.stack ? String(event.reason.stack).substring(0, 1500) : "",
        });
      });

      const _origErr = console.error;
      console.error = function() {
        const args = Array.from(arguments).map((a) => {
          if (a instanceof Error) return a.name + ": " + a.message + "\\n" + (a.stack || "").substring(0, 800);
          try { return typeof a === "object" ? JSON.stringify(a).substring(0, 500) : String(a); }
          catch (e) { return String(a); }
        }).join(" | ");
        fire("console_error", { args });
        _origErr.apply(console, arguments);
      };

      const _origWarn = console.warn;
      console.warn = function() {
        fire("console_warn", {
          args: Array.from(arguments).map((a) => String(a)).join(" | ").substring(0, 500),
        });
        _origWarn.apply(console, arguments);
      };

      setTimeout(() => {
        const root = document.getElementById("root");
        fire("page_dump_2s", {
          href: location.href,
          title: document.title,
          rootExists: !!root,
          rootChildren: root?.children?.length ?? -1,
          rootHTML: (root?.innerHTML || "").substring(0, 600),
          bodyChildren: document.body.children.length,
          scripts: document.querySelectorAll("script").length,
          failedScripts: Array.from(document.querySelectorAll("script[src]"))
            .map((s) => s.src).slice(0, 5).join(", "),
          odinBridge: !!window.odin,
          odinKeys: window.odin ? Object.keys(window.odin).slice(0, 10).join(",") : "none",
          hasSession: !!window.__ODIN_INITIAL_SESSION__,
          localStorageKeys: Object.keys(localStorage || {}).slice(0, 20).join(","),
        });
      }, 2000);
    })();
    """
}

@main
struct OdinNotchHostMain {
    static func main() {
        guard let options = parseLaunchOptions() else {
            fputs("Usage: OdinNotchHost --url <url> [--width 44] [--height 44] [--session-path <path>]\n", stderr)
            exit(64)
        }

        let app = NSApplication.shared
        let delegate = OdinNotchHost(options: options)
        app.delegate = delegate
        app.run()
    }
}
