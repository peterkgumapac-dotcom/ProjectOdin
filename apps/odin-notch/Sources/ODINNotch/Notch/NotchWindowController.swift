import AppKit
import SwiftUI

final class NotchWindowController {
    private let model: NotchModel
    private let onOpenSettings: () -> Void
    private var panel: NSPanel?
    private var hostingView: HoverTrackingHostingView<NotchShellView>?
    private var collapseWorkItem: DispatchWorkItem?
    private var outsideClickMonitor: Any?
    private var frameAnimationTimer: Timer?

    init(model: NotchModel, onOpenSettings: @escaping () -> Void) {
        self.model = model
        self.onOpenSettings = onOpenSettings
        self.model.onSurfaceStateChange = { [weak self] in
            self?.resizePanel(animated: true)
        }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenParametersDidChange),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    func show() {
        model.refreshGeometry()
        if panel == nil {
            createPanel()
            installOutsideClickMonitor()
        }
        reattach()
        panel?.orderFrontRegardless()
    }

    func reattach() {
        model.refreshGeometry()
        resizePanel(animated: false)
    }

    private func createPanel() {
        let frame = frameForCurrentState()
        let panel = NSPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = false

        let root = NotchShellView(model: model, onSettings: onOpenSettings)
        let hostingView = HoverTrackingHostingView(rootView: root)
        hostingView.frame = NSRect(origin: .zero, size: frame.size)
        hostingView.autoresizingMask = [.width, .height]
        hostingView.onMouseEntered = { [weak self] in self?.handleMouseEntered() }
        hostingView.onMouseExited = { [weak self] in self?.handleMouseExited() }
        hostingView.onFileDragEntered = { [weak self] in self?.handleFileDragEntered() }
        hostingView.onFileDragExited = { [weak self] in self?.handleFileDragExited() }
        hostingView.onFileDrop = { [weak self] urls in self?.handleFileDrop(urls) }
        panel.contentView = hostingView

        self.hostingView = hostingView
        self.panel = panel
    }

    private func handleMouseEntered() {
        collapseWorkItem?.cancel()
        guard model.liveActivity != .fileDrop else { return }
        guard model.hoverToExpand else { return }
        if !model.presentation.isExpanded {
            model.expand()
            resizePanel(animated: true)
        }
    }

    private func handleFileDragEntered() {
        collapseWorkItem?.cancel()
        model.enterFileDropMode()
        resizePanel(animated: true)
    }

    private func handleFileDragExited() {
        model.scheduleFileDropDismissIfEmpty()
    }

    private func handleFileDrop(_ urls: [URL]) {
        model.addClippedFiles(urls)
        resizePanel(animated: true)
    }

    private func handleMouseExited() {
        collapseWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                self?.collapseIfPointerOutsidePanel(animated: true)
            }
        }
        collapseWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + model.collapseDelay, execute: workItem)
    }

    private func resizePanel(animated: Bool) {
        guard let panel else { return }
        let frame = frameForCurrentState()
        hostingView?.frame = NSRect(origin: .zero, size: frame.size)

        if animated {
            animatePanel(panel, to: frame)
        } else {
            frameAnimationTimer?.invalidate()
            frameAnimationTimer = nil
            panel.setFrame(frame, display: true)
        }
        panel.contentView?.needsDisplay = true
    }

    private func animatePanel(_ panel: NSPanel, to targetFrame: NSRect) {
        frameAnimationTimer?.invalidate()

        let startFrame = panel.frame
        let startTime = CACurrentMediaTime()
        let isExpanding = targetFrame.size.height > startFrame.size.height
        let duration: TimeInterval = isExpanding ? 0.34 : 0.30

        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self, weak panel] timer in
            guard let self, let panel else {
                timer.invalidate()
                return
            }

            let elapsed = CACurrentMediaTime() - startTime
            let rawProgress = min(max(elapsed / duration, 0), 1)
            let progress = isExpanding
                ? self.springProgress(rawProgress)
                : self.smoothCollapseProgress(rawProgress)

            let interpolated = NSRect(
                x: self.interpolate(startFrame.origin.x, targetFrame.origin.x, progress),
                y: self.interpolate(startFrame.origin.y, targetFrame.origin.y, progress),
                width: self.interpolate(startFrame.size.width, targetFrame.size.width, progress),
                height: self.interpolate(startFrame.size.height, targetFrame.size.height, progress)
            )

            panel.setFrame(interpolated, display: true)

            if rawProgress >= 1 {
                timer.invalidate()
                panel.setFrame(targetFrame, display: true)
                panel.contentView?.needsDisplay = true
                self.frameAnimationTimer = nil
            }
        }

        frameAnimationTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func springProgress(_ progress: Double) -> CGFloat {
        let t = min(max(progress, 0), 1)
        let damping = 10.4
        let frequency = 8.4
        let value = 1 - exp(-damping * t) * (cos(frequency * t) + 0.08 * sin(frequency * t))
        return CGFloat(min(max(value, 0), 1.008))
    }

    private func smoothCollapseProgress(_ progress: Double) -> CGFloat {
        let t = min(max(progress, 0), 1)
        return CGFloat(t * t * (3 - (2 * t)))
    }

    private func interpolate(_ start: CGFloat, _ end: CGFloat, _ progress: CGFloat) -> CGFloat {
        start + ((end - start) * progress)
    }

    private func frameForCurrentState() -> NSRect {
        let geometry = model.geometry
        let screen = geometry.screenFrame
        let size = model.presentation.isExpanded ? geometry.expandedSize : geometry.compactSize(for: model.liveActivity)
        let anchorX = geometry.hasNotch ? geometry.notchX + (geometry.notchWidth / 2) : screen.midX
        let desiredX = anchorX - (size.width / 2)
        let x = min(max(desiredX, screen.minX + 12), screen.maxX - size.width - 12)

        let y: CGFloat
        if model.presentation.isExpanded {
            y = screen.maxY - size.height
        } else {
            let compactTopBleed: CGFloat = model.liveActivity == .resting ? min(size.height - geometry.menuBarHeight, 8) : 0
            y = screen.maxY - size.height + max(compactTopBleed, 0)
        }
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }

    private func collapseIfPointerOutsidePanel(animated: Bool) {
        guard let panel, model.presentation.isExpanded else { return }
        let pointer = NSEvent.mouseLocation
        let forgivingFrame = panel.frame.insetBy(dx: -10, dy: -8)
        guard !forgivingFrame.contains(pointer) else { return }

        model.collapse()
        resizePanel(animated: animated)
    }

    private func installOutsideClickMonitor() {
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            Task { @MainActor in
                guard let self, let panel = self.panel, self.model.presentation.isExpanded else { return }
                if !panel.frame.contains(NSEvent.mouseLocation) {
                    self.model.collapse()
                    self.resizePanel(animated: true)
                }
            }
        }
    }

    @objc private func screenParametersDidChange() {
        reattach()
    }
}
