import AppKit
import Sparkle

final class UpdateController: NSObject {
    private var updaterController: SPUStandardUpdaterController?

    override init() {
        super.init()

        guard Self.isConfigured else { return }

        updaterController = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
    }

    static var isConfigured: Bool {
        guard
            let feedURLString = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String,
            URL(string: feedURLString) != nil,
            let publicKey = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
            !publicKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return false
        }

        return true
    }

    @objc func checkForUpdates(_ sender: Any?) {
        guard let updaterController else {
            showNotConfiguredAlert()
            return
        }

        updaterController.checkForUpdates(sender)
    }

    private func showNotConfiguredAlert() {
        let alert = NSAlert()
        alert.messageText = "Updates are not configured yet"
        alert.informativeText = "Sparkle is installed. Build with SPARKLE_FEED_URL and SPARKLE_PUBLIC_ED_KEY to enable direct ODIN Notch update checks."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}
