import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let model = NotchModel()
    private lazy var settingsWindowController = SettingsWindowController(model: model)
    private lazy var notchWindowController = NotchWindowController(
        model: model,
        onOpenSettings: { [weak self] in self?.settingsWindowController.show() }
    )
    private var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard claimSingleInstance() else {
            NSApp.terminate(nil)
            return
        }
        configureStatusItem()
        model.refreshLocalData()
        model.startNativeMusicSync()
        notchWindowController.show()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        notchWindowController.reattach()
    }

    private func configureStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "ODIN"
        item.button?.font = .systemFont(ofSize: 11, weight: .semibold)

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Show Notch", action: #selector(showNotch), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Preview Calendar Peek", action: #selector(previewCalendarPeek), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Settings", action: #selector(showSettings), keyEquivalent: ","))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit ODIN Notch", action: #selector(quit), keyEquivalent: "q"))
        item.menu = menu
        statusItem = item
    }

    @objc private func showNotch() {
        notchWindowController.show()
    }

    @objc private func showSettings() {
        settingsWindowController.show()
    }

    @objc private func previewCalendarPeek() {
        model.refreshLocalData()
        Task { @MainActor [weak self] in
            guard let self else { return }
            let meetings = await LocalCalendarService.meetingsToday(limit: 12)
            guard let meeting = meetings
                .filter({ $0.startDate > Date() })
                .sorted(by: { $0.startDate < $1.startDate })
                .first
            else { return }
            self.notchWindowController.reattach()
            self.model.presentCalendarPeek(meeting)
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func claimSingleInstance() -> Bool {
        guard let bundleIdentifier = Bundle.main.bundleIdentifier else { return true }
        let currentPID = ProcessInfo.processInfo.processIdentifier
        let otherInstances = NSRunningApplication
            .runningApplications(withBundleIdentifier: bundleIdentifier)
            .filter { $0.processIdentifier != currentPID }

        guard let existing = otherInstances.first else { return true }
        existing.activate(options: [.activateIgnoringOtherApps])
        return false
    }
}
