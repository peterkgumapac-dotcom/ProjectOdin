import AppKit

enum FileShortcut: String, CaseIterable, Identifiable {
    case downloads = "Downloads"
    case screenshots = "Screenshots"
    case documents = "Documents"

    var id: String { rawValue }

    var systemImage: String {
        switch self {
        case .downloads: return "arrow.down.circle"
        case .screenshots: return "camera.viewfinder"
        case .documents: return "doc.text"
        }
    }

    var url: URL {
        switch self {
        case .downloads:
            return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
        case .screenshots:
            return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop")
        case .documents:
            return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Documents")
        }
    }
}

enum FileShortcutService {
    static func open(_ shortcut: FileShortcut) {
        NSWorkspace.shared.open(shortcut.url)
    }
}
