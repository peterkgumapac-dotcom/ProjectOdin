import AppKit
import Foundation
import UniformTypeIdentifiers

struct PhoneDropResult: Equatable {
    var success: Bool
    var message: String
}

enum PhoneDropService {
    private static let cliPath = "/Applications/KDE Connect.app/Contents/MacOS/kdeconnect-cli"

    static var isInstalled: Bool {
        FileManager.default.fileExists(atPath: cliPath)
    }

    static func openKDEConnect() {
        NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/KDE Connect.app"))
    }

    static func pairedDevice(retries: Int = 2) -> (id: String, name: String)? {
        for attempt in 0...retries {
            let output = runKDEConnect(arguments: ["--list-available", "--id-name-only"]).output
            let lines = output
                .split(separator: "\n")
                .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { line in
                    guard !line.isEmpty else { return false }
                    guard !line.contains("QDBusError"), !line.contains("error activating") else { return false }
                    return line.range(of: #"^[a-fA-F0-9]{16,}\s+"#, options: .regularExpression) != nil
                }

            if let first = lines.first {
                let parts = first.split(separator: " ", maxSplits: 1).map(String.init)
                if let id = parts.first, !id.isEmpty {
                    return (id: id, name: parts.count > 1 ? parts[1] : "Phone")
                }
            }

            if attempt < retries {
                Thread.sleep(forTimeInterval: 0.25)
            }
        }

        return nil
    }

    static func chooseAndSendFile() {
        guard let device = pairedDevice() else {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/KDE Connect.app"))
            return
        }

        let panel = NSOpenPanel()
        panel.title = "Send to \(device.name)"
        panel.prompt = "Send"
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false

        guard panel.runModal() == .OK, let url = panel.url else { return }
        _ = share(url: url, to: device.id)
    }

    @discardableResult
    static func share(url: URL, to deviceID: String? = nil) -> PhoneDropResult {
        let target = deviceID ?? pairedDevice(retries: 3)?.id
        guard let target else {
            DispatchQueue.main.async {
                NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/KDE Connect.app"))
            }
            return PhoneDropResult(success: false, message: "Phone link is waking up. Try again.")
        }

        let result = runKDEConnect(arguments: ["--device", target, "--share", url.path])
        if result.exitCode == 0 || result.output.contains("Shared file://") {
            return PhoneDropResult(success: true, message: "Sent to phone: \(url.lastPathComponent)")
        }

        let message = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
        let safeMessage = message.contains("QDBusError") || message.localizedCaseInsensitiveContains("error activating")
            ? "Phone connection is waking up. Try again."
            : message
        return PhoneDropResult(success: false, message: safeMessage.isEmpty ? "Send failed" : safeMessage)
    }

    static func share(itemProviders: [NSItemProvider]) -> Bool {
        return loadFileURLs(from: itemProviders) { urls in
            urls.forEach { share(url: $0) }
        }
    }

    static func loadFileURLs(from itemProviders: [NSItemProvider], completion: @escaping ([URL]) -> Void) -> Bool {
        let providers = itemProviders.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        guard !providers.isEmpty else { return false }

        let group = DispatchGroup()
        let lock = NSLock()
        var urls: [URL] = []

        providers.forEach { provider in
            group.enter()
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                if let url = fileURL(from: item) {
                    lock.lock()
                    urls.append(url)
                    lock.unlock()
                }
                group.leave()
            }
        }

        group.notify(queue: .main) {
            completion(urls)
        }

        return true
    }

    private static func fileURL(from item: NSSecureCoding?) -> URL? {
        if let url = item as? URL {
            return url
        }

        if let data = item as? Data {
            return URL(dataRepresentation: data, relativeTo: nil)
        }

        if let string = item as? String {
            if let url = URL(string: string), url.isFileURL {
                return url
            }
            return URL(fileURLWithPath: string)
        }

        return nil
    }

    @discardableResult
    private static func runKDEConnect(arguments: [String]) -> (output: String, exitCode: Int32) {
        guard FileManager.default.fileExists(atPath: cliPath) else {
            return ("KDE Connect is not installed", 127)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: cliPath)
        process.arguments = arguments

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return (String(data: data, encoding: .utf8) ?? "", process.terminationStatus)
        } catch {
            return (error.localizedDescription, 1)
        }
    }
}
