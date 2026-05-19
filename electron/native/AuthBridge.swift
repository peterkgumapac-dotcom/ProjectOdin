import Foundation
import WebKit

final class AuthBridge {
    static func readSessionJSON(at path: String?) -> String? {
        guard let path, !path.isEmpty else { return nil }
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        guard JSONSerialization.isValidJSONObject((try? JSONSerialization.jsonObject(with: data)) as Any) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func authInjectionScript(sessionJSON: String?) -> WKUserScript {
        let json = sessionJSON ?? "null"
        let source = """
        window.__ODIN_INITIAL_SESSION__ = \(json);
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false)
    }

    static func dispatchScript(eventName: String, payloadJSON: String? = nil) -> String {
        let detail = payloadJSON ?? "null"
        return "window.dispatchEvent(new CustomEvent('\(eventName)', { detail: \(detail) }));"
    }
}
