import Foundation

enum NotchPreferences {
    private enum Key {
        static let hoverToExpand = "hoverToExpand"
        static let collapseDelay = "collapseDelay"
        static let showDebugOverlay = "showDebugOverlay"
        static let quickAppBundleIdentifiers = "quickAppBundleIdentifiers"
        static let calendarPeekEnabled = "calendarPeekEnabled"
        static let calendarPeekLeadTime = "calendarPeekLeadTime"
        static let calendarPeekDisplayDuration = "calendarPeekDisplayDuration"
    }

    private static let defaults = UserDefaults.standard

    static var hoverToExpand: Bool {
        get {
            if defaults.object(forKey: Key.hoverToExpand) == nil { return true }
            return defaults.bool(forKey: Key.hoverToExpand)
        }
        set { defaults.set(newValue, forKey: Key.hoverToExpand) }
    }

    static var collapseDelay: TimeInterval {
        get {
            let value = defaults.double(forKey: Key.collapseDelay)
            return value > 0 ? value : 0.55
        }
        set { defaults.set(newValue, forKey: Key.collapseDelay) }
    }

    static var showDebugOverlay: Bool {
        get { defaults.bool(forKey: Key.showDebugOverlay) }
        set { defaults.set(newValue, forKey: Key.showDebugOverlay) }
    }

    static var quickAppBundleIdentifiers: [String] {
        get { defaults.stringArray(forKey: Key.quickAppBundleIdentifiers) ?? [] }
        set { defaults.set(Array(newValue.prefix(12)), forKey: Key.quickAppBundleIdentifiers) }
    }

    static var calendarPeekEnabled: Bool {
        get {
            if defaults.object(forKey: Key.calendarPeekEnabled) == nil { return true }
            return defaults.bool(forKey: Key.calendarPeekEnabled)
        }
        set { defaults.set(newValue, forKey: Key.calendarPeekEnabled) }
    }

    static var calendarPeekLeadTime: TimeInterval {
        get {
            let value = defaults.double(forKey: Key.calendarPeekLeadTime)
            return value > 0 ? value : 50 * 60
        }
        set { defaults.set(newValue, forKey: Key.calendarPeekLeadTime) }
    }

    static var calendarPeekDisplayDuration: TimeInterval {
        get {
            let value = defaults.double(forKey: Key.calendarPeekDisplayDuration)
            return value > 0 ? value : 10
        }
        set { defaults.set(newValue, forKey: Key.calendarPeekDisplayDuration) }
    }

    static func resetAll() {
        [
            Key.hoverToExpand,
            Key.collapseDelay,
            Key.showDebugOverlay,
            Key.quickAppBundleIdentifiers,
            Key.calendarPeekEnabled,
            Key.calendarPeekLeadTime,
            Key.calendarPeekDisplayDuration
        ].forEach { defaults.removeObject(forKey: $0) }
    }
}
