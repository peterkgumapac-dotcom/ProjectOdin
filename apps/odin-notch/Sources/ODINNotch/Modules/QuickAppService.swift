import AppKit

struct InstalledApp: Identifiable, Equatable {
    let id: String
    let name: String
    let bundleIdentifier: String
    let url: URL
}

enum QuickAppService {
    static func installedApps(limit: Int = 80) -> [InstalledApp] {
        let searchRoots = [
            URL(fileURLWithPath: "/Applications"),
            URL(fileURLWithPath: "/System/Applications"),
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")
        ]

        var seen = Set<String>()
        var apps: [InstalledApp] = []

        for root in searchRoots {
            guard let enumerator = FileManager.default.enumerator(
                at: root,
                includingPropertiesForKeys: [.isApplicationKey],
                options: [.skipsHiddenFiles, .skipsPackageDescendants]
            ) else { continue }

            for case let url as URL in enumerator {
                guard url.pathExtension == "app" else { continue }
                guard let bundle = Bundle(url: url) else { continue }
                let bundleIdentifier = bundle.bundleIdentifier ?? url.path
                guard !seen.contains(bundleIdentifier) else { continue }
                seen.insert(bundleIdentifier)

                let displayName = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
                let bundleName = bundle.object(forInfoDictionaryKey: "CFBundleName") as? String
                let fallbackName = url.deletingPathExtension().lastPathComponent
                let name = displayName ?? bundleName ?? fallbackName

                apps.append(InstalledApp(id: bundleIdentifier, name: name, bundleIdentifier: bundleIdentifier, url: url))
                if apps.count >= limit { break }
            }
            if apps.count >= limit { break }
        }

        return apps.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    static func open(bundleIdentifier: String) {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }
}
