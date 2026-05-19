import Foundation
import WebKit

protocol NotchMessageHandling: AnyObject {
    func handleNotchAction(_ action: String, payload: [String: Any])
}

final class NotchMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: NotchMessageHandling?

    init(delegate: NotchMessageHandling) {
        self.delegate = delegate
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "odin",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            return
        }
        let payload = body["payload"] as? [String: Any] ?? [:]
        delegate?.handleNotchAction(action, payload: payload)
    }
}
