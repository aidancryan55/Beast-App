import Capacitor
import WebKit

// Starting iOS 15, WKWebView requires the host app to explicitly grant
// getUserMedia (camera/mic) requests via WKUIDelegate — the
// NSCameraUsageDescription string alone is not enough inside a WKWebView
// the way it is in Safari. Without this, dual camera capture silently fails.
class MainViewController: CAPBridgeViewController, WKUIDelegate {
    override func viewDidLoad() {
        super.viewDidLoad()
        webView?.uiDelegate = self
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.grant)
    }
}
