import UIKit
import Capacitor
import UniformTypeIdentifiers
import WebKit
import Security
import CryptoKit
import Darwin

@objc(CalciteSecureStorage)
class CalciteSecureStorage: CAPPlugin, CAPBridgedPlugin {
    let identifier = "CalciteSecureStorage"
    let jsName = "CalciteSecureStorage"
    let pluginMethods = ["available", "get", "set", "decryptPair"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    private func query(_ call: CAPPluginCall) -> [String: Any]? {
        guard let key = call.getString("key"),
              key.range(of: #"^[0-9a-f-]{36}\.(pat|peer)$"#, options: .regularExpression) != nil else { return nil }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "io.calcite.notes.sync.v1", kSecAttrAccount as String: key]
    }

    @objc func available(_ call: CAPPluginCall) { call.resolve(["available": true]) }

    @objc func decryptPair(_ call: CAPPluginCall) {
        guard let encodedKey = call.getString("key"), let encodedIV = call.getString("iv"),
              let encodedData = call.getString("data"), encodedData.count <= 16000,
              let key = Data(base64Encoded: encodedKey), key.count == 32,
              let iv = Data(base64Encoded: encodedIV), iv.count == 12,
              let data = Data(base64Encoded: encodedData), data.count >= 16 else {
            call.reject("配对资料无效。"); return
        }
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: data.dropLast(16), tag: data.suffix(16))
            let plaintext = try AES.GCM.open(box, using: SymmetricKey(data: key))
            guard let value = String(data: plaintext, encoding: .utf8) else {
                call.reject("无法读取配对资料。"); return
            }
            call.resolve(["value": value])
        } catch { call.reject("无法读取配对资料。") }
    }

    @objc func get(_ call: CAPPluginCall) {
        guard var query = query(call) else { call.reject("系统密钥标识无效。"); return }
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { call.resolve(); return }
        guard status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            call.reject("系统密钥不可用。"); return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let query = query(call), let value = call.getString("value"), value.count <= 2048 else {
            call.reject("系统密钥参数无效。"); return
        }
        let result: OSStatus
        if value.isEmpty {
            result = SecItemDelete(query as CFDictionary)
        } else {
            let attributes = [kSecValueData as String: Data(value.utf8)]
            let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if update == errSecItemNotFound {
                var record = query
                record[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                record[kSecValueData as String] = Data(value.utf8)
                result = SecItemAdd(record as CFDictionary, nil)
            } else { result = update }
        }
        if result == errSecSuccess || value.isEmpty && result == errSecItemNotFound { call.resolve() }
        else { call.reject("无法保存系统密钥。") }
    }
}

@objc(CalciteRichClipboard)
class CalciteRichClipboard: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CalciteRichClipboard"
    public let jsName = "CalciteRichClipboard"
    public let pluginMethods = [CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise)]

    @objc func write(_ call: CAPPluginCall) {
        guard let html = call.getString("html"), let text = call.getString("text") else {
            call.reject("缺少剪贴板内容。")
            return
        }
        DispatchQueue.main.async {
            UIPasteboard.general.items = [[UTType.html.identifier: Data(html.utf8),
                                           UTType.utf8PlainText.identifier: text]]
            call.resolve()
        }
    }
}

@objc(CalciteAtomicFiles)
class CalciteAtomicFiles: CAPPlugin, CAPBridgedPlugin {
    let identifier = "CalciteAtomicFiles"
    let jsName = "CalciteAtomicFiles"
    let pluginMethods = ["rename", "flushDirectory", "sameFile"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    private func scoped(_ path: String?) throws -> URL {
        guard let path, path.hasPrefix("/CalciteVaults/"), !path.contains("\0"),
              let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            throw POSIXError(.EINVAL)
        }
        let root = documents.resolvingSymlinksInPath()
        let file = root.appendingPathComponent(String(path.dropFirst()))
        guard file.path == file.standardizedFileURL.path,
              file.path == file.resolvingSymlinksInPath().path else {
            throw POSIXError(.EINVAL)
        }
        return file
    }

    private func flush(_ file: URL) throws {
        let descriptor = Darwin.open(file.path, O_RDONLY)
        guard descriptor >= 0 else { throw POSIXError(.EIO) }
        defer { Darwin.close(descriptor) }
        guard fsync(descriptor) == 0 else { throw POSIXError(.EIO) }
    }

    @objc func flushDirectory(_ call: CAPPluginCall) {
        do {
            try flush(scoped(call.getString("path")))
            call.resolve()
        } catch {
            call.reject("Directory sync failed", "ATOMIC_RENAME", error)
        }
    }

    @objc func sameFile(_ call: CAPPluginCall) {
        do {
            let from = try scoped(call.getString("from")), to = try scoped(call.getString("to"))
            var first = stat(), second = stat()
            guard Darwin.lstat(from.path, &first) == 0, Darwin.lstat(to.path, &second) == 0 else {
                throw POSIXError(.EIO)
            }
            call.resolve(["same": first.st_dev == second.st_dev && first.st_ino == second.st_ino])
        } catch {
            call.reject("File identity check failed", "ATOMIC_RENAME", error)
        }
    }

    @objc func rename(_ call: CAPPluginCall) {
        do {
            let from = try scoped(call.getString("from")), to = try scoped(call.getString("to"))
            let source = from.deletingLastPathComponent(), target = to.deletingLastPathComponent()
            if call.getBool("temporary") == true {
                guard source == target, from.lastPathComponent.hasPrefix(".calcite-tmp-") else {
                    throw POSIXError(.EINVAL)
                }
                try flush(from)
            }
            if call.getBool("exclusive") == true {
                if Darwin.link(from.path, to.path) != 0 {
                    if errno == EEXIST {
                        call.reject("Destination already exists", "EEXIST")
                        return
                    }
                    throw POSIXError(.EIO)
                }
            } else {
                guard Darwin.rename(from.path, to.path) == 0 else { throw POSIXError(.EIO) }
            }
            try flush(target)
            if source != target { try flush(source) }
            call.resolve()
        } catch {
            call.reject("Atomic rename failed", "ATOMIC_RENAME", error)
        }
    }
}

class CalciteBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(CalciteRichClipboard())
        bridge?.registerPluginInstance(CalciteSecureStorage())
        bridge?.registerPluginInstance(CalciteAtomicFiles())
        bridge?.registerPluginInstance(CalciteDocumentCapture())
    }
}

@objc(CalciteDocumentCapture)
class CalciteDocumentCapture: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CalciteDocumentCapture"
    public let jsName = "CalciteDocumentCapture"
    public let pluginMethods = [CAPPluginMethod(name: "png", returnType: CAPPluginReturnPromise)]
    private var captures: [UUID: Snapshot] = [:]

    @objc func png(_ call: CAPPluginCall) {
        guard let html = call.getString("html"), let width = call.getInt("width"), let scale = call.getInt("scale"),
              (320...1200).contains(width), (1...3).contains(scale) else {
            call.reject("长图参数无效。")
            return
        }
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController?.view else {
                call.reject("无法访问导出视图。")
                return
            }
            let id = UUID()
            let snapshot = Snapshot(width: CGFloat(width), scale: CGFloat(scale), host: host) { data in
                self.captures.removeValue(forKey: id)
                if let data {
                    call.resolve(["data": data.base64EncodedString()])
                } else {
                    call.reject("无法生成长图，请降低清晰度或分段导出。")
                }
            }
            self.captures[id] = snapshot
            snapshot.webView.loadHTMLString(html, baseURL: nil)
        }
    }

    private class Snapshot: NSObject, WKNavigationDelegate {
        let webView: WKWebView
        let width: CGFloat
        let scale: CGFloat
        var complete: ((Data?) -> Void)?

        init(width: CGFloat, scale: CGFloat, host: UIView, complete: @escaping (Data?) -> Void) {
            let configuration = WKWebViewConfiguration()
            configuration.defaultWebpagePreferences.allowsContentJavaScript = false
            configuration.websiteDataStore = .nonPersistent()
            self.width = width
            self.scale = scale
            self.complete = complete
            webView = WKWebView(frame: CGRect(x: 0, y: 0, width: width, height: 256), configuration: configuration)
            super.init()
            webView.navigationDelegate = self
            webView.isUserInteractionEnabled = false
            host.insertSubview(webView, at: 0)
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in self?.finish(nil) }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            DispatchQueue.main.async {
                let height = max(64, ceil(webView.scrollView.contentSize.height))
                guard height * self.width * self.scale * self.scale <= 16_000_000 else {
                    self.finish(nil)
                    return
                }
                webView.frame.size.height = height
                webView.layoutIfNeeded()
                let config = WKSnapshotConfiguration()
                config.rect = CGRect(x: 0, y: 0, width: self.width, height: height)
                config.snapshotWidth = NSNumber(value: Double(self.width * self.scale))
                webView.takeSnapshot(with: config) { image, _ in self.finish(image?.pngData()) }
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            finish(nil)
        }

        private func finish(_ data: Data?) {
            let callback = complete
            complete = nil
            webView.removeFromSuperview()
            callback?(data)
        }
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CalciteBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
