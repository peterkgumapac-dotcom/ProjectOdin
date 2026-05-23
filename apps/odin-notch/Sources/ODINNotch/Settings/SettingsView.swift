import AppKit
import EventKit
import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: NotchModel
    let updateController: UpdateController

    private var calendarStatus: SetupStatus {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .authorized, .fullAccess:
            return .ready("Calendar permission granted")
        case .notDetermined:
            return .needsSetup("Calendar permission not requested")
        case .denied, .restricted, .writeOnly:
            return .blocked("Calendar permission blocked")
        @unknown default:
            return model.meetings.isEmpty
                ? .needsSetup("Calendar status unknown")
                : .ready("Calendar events available")
        }
    }

    private var mediaStatus: SetupStatus {
        if model.music.isAvailable {
            return .ready("\(model.music.sourceName) is playing")
        }

        if appIsInstalled(bundleIdentifier: "com.spotify.client") || appIsInstalled(bundleIdentifier: "com.apple.Music") {
            return .needsSetup("Open Spotify, Music, or YouTube Music, then press play")
        }

        return .needsSetup("Install Spotify, use Apple Music, or open music.youtube.com")
    }

    private var quickAppsStatus: SetupStatus {
        model.quickApps.isEmpty
            ? .needsSetup("Add local apps or folders")
            : .ready("\(model.quickApps.count) shortcut\(model.quickApps.count == 1 ? "" : "s") ready")
    }

    private var phoneDropStatus: SetupStatus {
        guard PhoneDropService.isInstalled else {
            return .needsSetup("Install KDE Connect for phone sharing")
        }

        if let device = PhoneDropService.pairedDevice(retries: 0) {
            return .ready("Paired with \(device.name)")
        }

        return .needsSetup("KDE Connect installed, pair a phone")
    }

    var body: some View {
        Form {
            Section("Setup checklist") {
                SetupStatusRow(title: "Calendar", status: calendarStatus)
                SetupStatusRow(title: "Media", status: mediaStatus)
                SetupStatusRow(title: "Quick Apps", status: quickAppsStatus)
                SetupStatusRow(title: "Phone Drop", status: phoneDropStatus)
            }

            Section("Calendar") {
                Text("ODIN Notch reads local macOS Calendar events only. Nothing is uploaded.")
                    .foregroundStyle(.secondary)

                Button("Refresh local calendar") {
                    model.refreshLocalData()
                }

                Button("Open Calendar privacy settings") {
                    openPrivacyPane("Privacy_Calendars")
                }

                Toggle("Show event peek alerts", isOn: $model.calendarPeekEnabled)

                HStack {
                    Text("Reminder")
                    Slider(value: $model.calendarPeekLeadTime, in: 5 * 60...120 * 60, step: 5 * 60)
                    Text("\(Int(model.calendarPeekLeadTime / 60))m before")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }

                HStack {
                    Text("Display")
                    Slider(value: $model.calendarPeekDisplayDuration, in: 5...20, step: 1)
                    Text("\(Int(model.calendarPeekDisplayDuration))s")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }

                Button("Preview next event peek") {
                    model.refreshLocalData()
                    if let meeting = model.meetings
                        .filter({ $0.startDate > Date() })
                        .sorted(by: { $0.startDate < $1.startDate })
                        .first {
                        model.presentCalendarPeek(meeting)
                    }
                }
            }

            Section("Media") {
                Text("Media uses local app automation. Spotify, Apple Music, and YouTube Music stay separate; ODIN does not replace those connections.")
                    .foregroundStyle(.secondary)

                HStack {
                    Button("Open Spotify") {
                        openApp(bundleIdentifier: "com.spotify.client", fallbackPath: "/Applications/Spotify.app")
                    }

                    Button("Open Music") {
                        openApp(bundleIdentifier: "com.apple.Music", fallbackPath: "/System/Applications/Music.app")
                    }

                    Button("Open YouTube Music") {
                        if let url = URL(string: "https://music.youtube.com") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                }

                Button("Open Automation privacy settings") {
                    openPrivacyPane("Privacy_Automation")
                }
            }

            Section("Quick Apps") {
                Text("Quick Apps are local shortcuts. Add apps from this Mac; launching uses macOS, not OAuth or cloud sync.")
                    .foregroundStyle(.secondary)

                ForEach(model.quickApps) { app in
                    HStack {
                        Text(app.name)
                        Spacer()
                        Button("Remove") {
                            model.removeQuickApp(app)
                        }
                    }
                }

                Menu("Add installed app") {
                    ForEach(model.installedApps.prefix(50)) { app in
                        Button(app.name) {
                            model.addQuickApp(app)
                        }
                    }
                }
            }

            Section("Phone Drop") {
                Text("Phone Drop uses KDE Connect locally. Install KDE Connect on this Mac and the phone, pair them, then share files from the notch.")
                    .foregroundStyle(.secondary)

                Button(PhoneDropService.isInstalled ? "Open KDE Connect" : "Install or open KDE Connect") {
                    PhoneDropService.openKDEConnect()
                }

                Button("Open Downloads page") {
                    if let url = URL(string: "https://kdeconnect.kde.org/download.html") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }

            Section("Updates") {
                Text("Sparkle is installed for direct macOS updates. OTA checks turn on once this build has an appcast URL and Sparkle EdDSA public key.")
                    .foregroundStyle(.secondary)

                Button("Check for Updates...") {
                    updateController.checkForUpdates(nil)
                }

                if !UpdateController.isConfigured {
                    Text("Build with SPARKLE_FEED_URL and SPARKLE_PUBLIC_ED_KEY to enable update checks.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Behavior") {
                Toggle("Hover to expand", isOn: $model.hoverToExpand)

                HStack {
                    Text("Collapse delay")
                    Slider(value: $model.collapseDelay, in: 0.2...1.5)
                    Text(String(format: "%.2fs", model.collapseDelay))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }

            Section("Privacy and clean slate") {
                Text("Friend-test reset clears ODIN Notch settings, quick apps, dropped files, notes, debug state, and active peeks. It does not delete system Calendar, Spotify, Music, or KDE Connect data.")
                    .foregroundStyle(.secondary)

                Button("Reset ODIN Notch for a new tester", role: .destructive) {
                    model.resetForNewUser()
                }
            }

            Section("Debug") {
                Toggle("Show geometry overlay", isOn: $model.showDebugOverlay)
                Text("Notch geometry is read from NSScreen at runtime. No hardcoded notch dimensions.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    private func appIsInstalled(bundleIdentifier: String) -> Bool {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) != nil
    }

    private func openApp(bundleIdentifier: String, fallbackPath: String) {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) {
            NSWorkspace.shared.open(url)
        } else {
            NSWorkspace.shared.open(URL(fileURLWithPath: fallbackPath))
        }
    }

    private func openPrivacyPane(_ anchor: String) {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else { return }
        NSWorkspace.shared.open(url)
    }
}

private enum SetupStatus {
    case ready(String)
    case needsSetup(String)
    case blocked(String)

    var icon: String {
        switch self {
        case .ready:
            return "checkmark.circle.fill"
        case .needsSetup:
            return "circle.dashed"
        case .blocked:
            return "exclamationmark.triangle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .ready:
            return .green
        case .needsSetup:
            return .orange
        case .blocked:
            return .red
        }
    }

    var message: String {
        switch self {
        case .ready(let message), .needsSetup(let message), .blocked(let message):
            return message
        }
    }
}

private struct SetupStatusRow: View {
    let title: String
    let status: SetupStatus

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: status.icon)
                .foregroundStyle(status.tint)
                .font(.title3)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline)
                Text(status.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()
        }
        .padding(.vertical, 4)
    }
}
