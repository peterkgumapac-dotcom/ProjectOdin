import Foundation

struct HealthSnapshot: Equatable {
    var connected: Bool
    var needsReconnect: Bool
    var checkedAt: String?
    var exportedAt: String?
    var error: String?
    var heartBpm: Int?
    var sleepMinutes: Int?
    var steps: Int?
    var weightKg: Double?

    static let empty = HealthSnapshot(
        connected: false,
        needsReconnect: false,
        checkedAt: nil,
        exportedAt: nil,
        error: nil,
        heartBpm: nil,
        sleepMinutes: nil,
        steps: nil,
        weightKg: nil
    )
}

enum HealthSnapshotService {
    private struct Payload: Decodable {
        struct HeartRate: Decodable {
            var bpm: Int?
        }

        struct Sleep: Decodable {
            var durationMinutes: Int?
        }

        struct Steps: Decodable {
            var count: Int?
        }

        struct Weight: Decodable {
            var kg: Double?
        }

        var connected: Bool?
        var needsReconnect: Bool?
        var checkedAt: String?
        var exportedAt: String?
        var error: String?
        var heartRate: HeartRate?
        var sleep: Sleep?
        var steps: Steps?
        var weight: Weight?
    }

    static var snapshotURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("ODIN", isDirectory: true)
            .appendingPathComponent("health-snapshot.json")
    }

    static func currentSnapshot() async -> HealthSnapshot {
        guard let url = snapshotURL else { return .empty }
        do {
            let data = try Data(contentsOf: url)
            let payload = try JSONDecoder().decode(Payload.self, from: data)
            return HealthSnapshot(
                connected: payload.connected ?? false,
                needsReconnect: payload.needsReconnect ?? false,
                checkedAt: payload.checkedAt,
                exportedAt: payload.exportedAt,
                error: payload.error,
                heartBpm: payload.heartRate?.bpm,
                sleepMinutes: payload.sleep?.durationMinutes,
                steps: payload.steps?.count,
                weightKg: payload.weight?.kg
            )
        } catch {
            return .empty
        }
    }
}
