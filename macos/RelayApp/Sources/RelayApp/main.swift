import AppKit
import Foundation
import WebKit
import Sparkle
import Darwin
import CryptoKit

struct RelayReadyEnvelope: Decodable {
  let protocolVersion: Int
  let pid: Int32
  let port: Int
  let url: String
  let token: String
}

private final class NodeServiceController {
  private(set) var process: Process?
  private let readyFile: URL
  private let dataDirectory: URL
  private let resourceDirectory: URL
  private let completion: (Result<RelayReadyEnvelope, Error>) -> Void
  private var timer: DispatchSourceTimer?
  private var finished = false
  private var stopping = false
  private var stopCallbacks: [() -> Void] = []

  init(resourceDirectory: URL, dataDirectory: URL, completion: @escaping (Result<RelayReadyEnvelope, Error>) -> Void) {
    self.resourceDirectory = resourceDirectory
    self.dataDirectory = dataDirectory
    self.readyFile = FileManager.default.temporaryDirectory
      .appendingPathComponent("relay-ready-\(UUID().uuidString).json")
    self.completion = completion
  }

  func start() {
    let node = resourceDirectory.appendingPathComponent("node/bin/node")
    let loader = resourceDirectory.appendingPathComponent("server/node_modules/tsx/dist/loader.mjs")
    let entrypoint = resourceDirectory.appendingPathComponent("server/src/server/main.ts")
    let child = Process()
    child.executableURL = node
    child.arguments = [
      "--import", loader.path, entrypoint.path, "--port", "0", "--data-dir", dataDirectory.path,
      "--ready-file", readyFile.path, "--root", resourceDirectory.appendingPathComponent("server").path,
    ]
    var environment = ProcessInfo.processInfo.environment
    environment["NODE_ENV"] = "production"
    environment["RELAY_DATA_DIR"] = dataDirectory.path
    environment["RELAY_READY_FILE"] = readyFile.path
    environment["RELAY_ROOT"] = resourceDirectory.appendingPathComponent("server").path
    environment.removeValue(forKey: "NODE_OPTIONS")
    environment.removeValue(forKey: "NODE_PATH")
    environment["RELAY_APP_VERSION"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    environment["RELAY_APP_BUILD"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
    environment["RELAY_APP_CHANNEL"] = "development"
    environment["RELAY_DESKTOP"] = "1"
    environment["RELAY_CLAUDE_ENV_EXPLICIT"] = environment["RELAY_CLAUDE_ENV_EXPLICIT"] ?? (getppid() == 1 ? "0" : "1")
    let localBin = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path
    environment["PATH"] = resourceDirectory.appendingPathComponent("node/bin").path + ":" + localBin + ":/opt/homebrew/bin:/usr/local/bin:" + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
    child.environment = environment
    child.standardOutput = FileHandle.nullDevice
    child.standardError = FileHandle.nullDevice
    child.terminationHandler = { [weak self] process in
      DispatchQueue.main.async {
        guard let self, !self.stopping else { return }
        self.finish(.failure(NSError(domain: "RelayApp", code: 2, userInfo: [NSLocalizedDescriptionKey: "Relay 服务提前退出（\(process.terminationStatus)）"])))
      }
    }
    do {
      try child.run()
      process = child
      pollReady(deadline: Date().addingTimeInterval(20))
    } catch {
      finish(.failure(error))
    }
  }

  func stop(completion: @escaping () -> Void) {
    if stopping && process == nil { completion(); return }
    stopCallbacks.append(completion)
    guard !stopping else { return }
    stopping = true
    finished = true
    timer?.cancel()
    timer = nil
    let child = process
    if let child, child.isRunning { child.terminate() }
    DispatchQueue.global(qos: .utility).async { [weak self] in
      child?.waitUntilExit()
      DispatchQueue.main.async {
        guard let self else { return }
        self.process = nil
        try? FileManager.default.removeItem(at: self.readyFile)
        let callbacks = self.stopCallbacks
        self.stopCallbacks.removeAll()
        callbacks.forEach { $0() }
      }
    }
  }

  private func pollReady(deadline: Date) {
    let source = DispatchSource.makeTimerSource(queue: .main)
    timer = source
    source.schedule(deadline: .now(), repeating: .milliseconds(100))
    source.setEventHandler { [weak self] in
      guard let self else { return }
      if Date() > deadline {
        self.finish(.failure(NSError(domain: "RelayApp", code: 3, userInfo: [NSLocalizedDescriptionKey: "Relay 服务启动超时"])))
        return
      }
      guard let data = try? Data(contentsOf: self.readyFile) else { return }
      do {
        let ready = try JSONDecoder().decode(RelayReadyEnvelope.self, from: data)
        guard ready.protocolVersion == 1,
              ready.pid == self.process?.processIdentifier,
              ready.port > 0 && ready.port < 65536,
              let url = URL(string: ready.url),
              url.scheme == "http", url.host == "127.0.0.1", Int(url.port ?? 0) == ready.port,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              ready.token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
          throw NSError(domain: "RelayApp", code: 4, userInfo: [NSLocalizedDescriptionKey: "Relay ready 文件无效"])
        }
        self.finish(.success(ready))
      } catch {
        self.finish(.failure(error))
      }
    }
    source.resume()
  }

  private func finish(_ result: Result<RelayReadyEnvelope, Error>) {
    guard !finished else { return }
    finished = true
    timer?.cancel()
    timer = nil
    completion(result)
  }
}

private final class WebViewCoordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
  private var ready: RelayReadyEnvelope?
  private var origins = Set<String>()
  private var picker: NSOpenPanel?

  private func permitted(_ message: WKScriptMessage) -> Bool {
    let source = message.frameInfo.securityOrigin
    return message.frameInfo.isMainFrame && source.protocol == "http" &&
      origins.contains("http://\(source.host):\(source.port)")
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                             replyHandler: @escaping (Any?, String?) -> Void) {
    guard permitted(message), message.name == "relayPicker",
          let body = message.body as? [String: Any], body["action"] as? String == "pickFolder",
          let window = message.webView?.window else {
      replyHandler(nil, "拒绝选择器请求"); return
    }
    guard picker == nil else { replyHandler(nil, "文件夹选择器已打开"); return }
    let panel = NSOpenPanel()
    picker = panel
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.canCreateDirectories = false
    panel.allowsMultipleSelection = false
    panel.beginSheetModal(for: window) { [weak self] response in
      self?.picker = nil
      if response == .OK, let url = panel.url {
        replyHandler(["path": url.path], nil)
      } else { replyHandler(["cancelled": true], nil) }
    }
  }

  func configure(_ ready: RelayReadyEnvelope) {
    self.ready = ready
    origins = [ready.url]
  }

  private func origin(_ url: URL) -> String? {
    guard url.scheme == "http", url.host == "127.0.0.1", let port = url.port,
          port > 0, port < 65536, url.user == nil, url.password == nil else { return nil }
    return "http://127.0.0.1:\(port)"
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard permitted(message),
          message.name == "relayNative", let body = message.body as? [String: Any],
          let action = body["action"] as? String,
          ["chat-new", "project", "command-palette", "latest", "toggle-terminals", "settings", "checkForUpdates"].contains(action) else { return }
    NotificationCenter.default.post(name: .relayNativeCommand, object: action)
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
    guard let candidate = origin(url) else {
      if navigationAction.navigationType == .linkActivated,
         ["https", "http", "mailto"].contains(url.scheme ?? ""),
         url.host != "localhost", url.host != "127.0.0.1", url.host != "::1" {
        NSWorkspace.shared.open(url)
      }
      decisionHandler(.cancel)
      return
    }
    func allow() {
      if navigationAction.targetFrame == nil {
        decisionHandler(.cancel)
        webView.load(URLRequest(url: url))
      } else { decisionHandler(.allow) }
    }
    if origins.contains(candidate) { allow(); return }
    guard let ready else { decisionHandler(.cancel); return }
    // Only the owning Relay service may authorize another project console's origin.
    var components = URLComponents(string: ready.url + "/api/desktop/origin")!
    components.queryItems = [URLQueryItem(name: "origin", value: candidate)]
    var request = URLRequest(url: components.url!)
    request.timeoutInterval = 5
    request.setValue("Bearer " + ready.token, forHTTPHeaderField: "Authorization")
    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      DispatchQueue.main.async {
        guard let self, let data, (response as? HTTPURLResponse)?.statusCode == 200,
              let result = try? JSONSerialization.jsonObject(with: data) as? [String: Bool],
              result["allowed"] == true else { decisionHandler(.cancel); return }
        self.origins.insert(candidate)
        allow()
      }
    }.resume()
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    let alert = NSAlert()
    alert.messageText = "Relay 页面已停止"
    alert.informativeText = "可以重新加载本地页面并继续当前项目。"
    alert.addButton(withTitle: "重新加载")
    alert.addButton(withTitle: "稍后")
    if alert.runModal() == .alertFirstButtonReturn { webView.reload() }
  }
}

extension Notification.Name {
  fileprivate static let relayNativeCommand = Notification.Name("relay.native-command")
}

@main
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private var window: NSWindow!
  private var webView: WKWebView!
  private var node: NodeServiceController?
  private var updater: SPUStandardUpdaterController?
  private let coordinator = WebViewCoordinator()
  private var keyMonitor: Any?
  private var dataDirectory: URL?
  private var windowPreference = "RelayMainWindow"
  private var terminating = false

  static func main() {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.setActivationPolicy(.regular)
    application.delegate = delegate
    withExtendedLifetime(delegate) { application.run() }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    if let override = ProcessInfo.processInfo.environment["RELAY_APP_DATA_DIR"] {
      let digest = SHA256.hash(data: Data(override.utf8)).map { String(format: "%02x", $0) }.joined()
      windowPreference += "-" + String(digest.prefix(16))
    }
    configureMenu()
    // Placeholder feeds must never initiate a production update check.
    if let feed = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String,
       let url = URL(string: feed), url.scheme == "https", !(url.host?.hasSuffix(".invalid") ?? true),
       let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
       Data(base64Encoded: key)?.count == 32 {
      updater = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    }
    let configuration = WKWebViewConfiguration()
    configuration.userContentController.add(coordinator, name: "relayNative")
    configuration.userContentController.addScriptMessageHandler(coordinator, contentWorld: .page, name: "relayPicker")
    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = coordinator
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "Relay"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = false
    window.isMovable = true
    window.toolbarStyle = .unified
    window.contentView = webView
    window.minSize = NSSize(width: 1100, height: 720)
    window.delegate = self
    window.setFrameAutosaveName(windowPreference)
    if !window.setFrameUsingName(windowPreference) { window.center() }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    NotificationCenter.default.addObserver(self, selector: #selector(nativeCommand(_:)), name: .relayNativeCommand, object: nil)
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      if event.keyCode == 53, event.window === self?.window {
        self?.send("escape")
        return nil
      }
      return event
    }
    let resources = Bundle.main.resourceURL ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    let override = ProcessInfo.processInfo.environment["RELAY_APP_DATA_DIR"]
    let data = override.map { URL(fileURLWithPath: $0, isDirectory: true) }
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Relay", isDirectory: true)
    dataDirectory = data
    node = NodeServiceController(resourceDirectory: resources, dataDirectory: data) { [weak self] result in
      switch result {
      case .success(let ready):
        self?.coordinator.configure(ready)
        var components = URLComponents(string: ready.url)
        components?.fragment = "token=\(ready.token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ready.token)"
        if let url = components?.url { self?.webView.load(URLRequest(url: url)) }
        if let self, UserDefaults.standard.bool(forKey: self.windowPreference + ".fullScreen") {
          self.window.toggleFullScreen(nil)
        }
      case .failure(let error):
        self?.showError(error)
      }
    }
    node?.start()
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    saveWindowState()
    guard let node, node.process != nil else { return .terminateNow }
    node.stop { NSApp.reply(toApplicationShouldTerminate: true) }
    return .terminateLater
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  private func saveWindowState() {
    guard !terminating else { return }
    terminating = true
    UserDefaults.standard.set(window.styleMask.contains(.fullScreen), forKey: windowPreference + ".fullScreen")
  }
  func windowWillClose(_ notification: Notification) { saveWindowState() }
  func windowDidEnterFullScreen(_ notification: Notification) {
    if !terminating { UserDefaults.standard.set(true, forKey: windowPreference + ".fullScreen") }
  }
  func windowDidExitFullScreen(_ notification: Notification) {
    if !terminating { UserDefaults.standard.set(false, forKey: windowPreference + ".fullScreen") }
  }

  @objc private func nativeCommand(_ notification: Notification) {
    guard let action = notification.object as? String else { return }
    if action == "checkForUpdates" { checkForUpdates(); return }
    let escaped = action.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
    webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('relay:native-command',{detail:'\(escaped)'}))")
  }

  private func showError(_ error: Error) {
    let alert = NSAlert(error: error)
    alert.messageText = "Relay 无法启动"
    alert.addButton(withTitle: "退出")
    alert.runModal()
    NSApp.terminate(nil)
  }

  private func configureMenu() {
    let main = NSMenu()
    let app = NSMenuItem()
    main.addItem(app)
    let appMenu = NSMenu()
    app.submenu = appMenu
    appMenu.addItem(withTitle: "关于 Relay", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "检查更新", action: #selector(checkForUpdates), keyEquivalent: "u").keyEquivalentModifierMask = [.command]
    appMenu.addItem(withTitle: "退出 Relay", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q").keyEquivalentModifierMask = [.command]
    let file = NSMenuItem(title: "文件", action: nil, keyEquivalent: "")
    file.submenu = NSMenu(title: "文件")
    file.submenu?.addItem(withTitle: "新建聊天", action: #selector(newChat), keyEquivalent: "n").keyEquivalentModifierMask = [.command]
    file.submenu?.addItem(withTitle: "新建项目", action: #selector(selectProject), keyEquivalent: "p").keyEquivalentModifierMask = [.command, .shift]
    file.submenu?.addItem(withTitle: "导入现有 Relay 数据", action: #selector(importData), keyEquivalent: "")
    main.addItem(file)
    let view = NSMenuItem(title: "查看", action: nil, keyEquivalent: "")
    view.submenu = NSMenu(title: "查看")
    view.submenu?.addItem(withTitle: "命令面板", action: #selector(commandPalette), keyEquivalent: "k").keyEquivalentModifierMask = [.command]
    view.submenu?.addItem(withTitle: "显示最新", action: #selector(showLatest), keyEquivalent: "")
    view.submenu?.addItem(withTitle: "显示／隐藏终端", action: #selector(toggleTerminals), keyEquivalent: "")
    view.submenu?.addItem(withTitle: "偏好设置", action: #selector(settings), keyEquivalent: ",").keyEquivalentModifierMask = [.command]
    view.submenu?.addItem(.separator())
    view.submenu?.addItem(withTitle: "进入／退出全屏", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.control, .command]
    view.submenu?.addItem(withTitle: "重新加载页面", action: #selector(reloadPage), keyEquivalent: "r").keyEquivalentModifierMask = [.command]
    main.addItem(view)
    NSApp.mainMenu = main
  }

  @objc private func newChat() { send("chat-new") }
  @objc private func selectProject() { send("project") }
  @objc private func commandPalette() { send("command-palette") }
  @objc private func showLatest() { send("latest") }
  @objc private func toggleTerminals() { send("toggle-terminals") }
  @objc private func settings() { send("settings") }
  @objc private func checkForUpdates() {
    guard let updater else {
      let alert = NSAlert()
      alert.messageText = "开发版尚未配置更新"
      alert.informativeText = "正式更新需要有效的签名、公证和更新源。"
      alert.runModal()
      return
    }
    updater.checkForUpdates(nil)
  }
  @objc private func reloadPage() { webView.reload() }
  @objc private func importData() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.allowsMultipleSelection = false
    panel.prompt = "选择并导入"
    panel.message = "选择已停止服务的 Relay 数据目录。导入前会备份 App 数据，原目录不会被修改。"
    guard panel.runModal() == .OK, let source = panel.url else { return }
    guard let destination = dataDirectory else { return }
    do { try RelayDataImporter.validate(source: source, destination: destination) }
    catch { showNotice(error); return }
    let confirmation = NSAlert()
    confirmation.messageText = "导入 Relay 数据？"
    confirmation.informativeText = "将停止当前本地服务，把所选目录复制到 App 数据目录，并在覆盖前生成备份。"
    confirmation.addButton(withTitle: "导入并退出")
    confirmation.addButton(withTitle: "取消")
    guard confirmation.runModal() == .alertFirstButtonReturn else { return }
    node?.stop { [weak self] in
      self?.copyImportedData(source: source, destination: destination)
    }
  }

  private func copyImportedData(source: URL, destination: URL) {
    do {
      try RelayDataImporter.install(source: source, destination: destination)
      let alert = NSAlert()
      alert.messageText = "数据已导入"
      alert.informativeText = "Relay 将退出并在下次启动时使用导入的数据。"
      alert.addButton(withTitle: "退出")
      alert.runModal()
      NSApp.terminate(nil)
    } catch {
      showNotice(error)
      NSApp.terminate(nil)
    }
  }

  private func send(_ action: String) { NotificationCenter.default.post(name: .relayNativeCommand, object: action) }

  private func showNotice(_ error: Error) {
    let alert = NSAlert(error: error)
    alert.messageText = "导入 Relay 数据失败"
    alert.runModal()
  }
}
