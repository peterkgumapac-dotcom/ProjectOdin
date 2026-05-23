import AppKit
import SwiftUI

final class SettingsWindowController {
    private let model: NotchModel
    private let updateController = UpdateController()
    private var window: NSWindow?

    init(model: NotchModel) {
        self.model = model
    }

    func show() {
        if window == nil {
            let root = SettingsView(model: model, updateController: updateController)
            let hosting = NSHostingView(rootView: root)
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 520, height: 420),
                styleMask: [.titled, .closable, .miniaturizable],
                backing: .buffered,
                defer: false
            )
            window.title = "ODIN Notch Settings"
            window.contentView = hosting
            window.center()
            self.window = window
        }

        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
