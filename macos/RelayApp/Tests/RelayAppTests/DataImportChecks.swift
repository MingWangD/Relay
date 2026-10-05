import Foundation

@main
struct DataImportChecks {
  static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw NSError(domain: "RelayImportTest", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
  }
  static func fails(_ action: () throws -> Void) throws {
    var failed = false
    do { try action() } catch { failed = true }
    try check(failed, "Expected import rejection")
  }
  static func fixture(_ action: (URL, URL, URL) throws -> Void) throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("relay-import-test-\(UUID().uuidString)")
    let source = root.appendingPathComponent("source")
    let destination = root.appendingPathComponent("Relay")
    try fm.createDirectory(at: source, withIntermediateDirectories: true)
    try fm.createDirectory(at: destination, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: root) }
    try Data("SQLite format 3\0source".utf8).write(to: source.appendingPathComponent("relay.sqlite"))
    try Data("old-data".utf8).write(to: destination.appendingPathComponent("marker"))
    try action(root, source, destination)
  }
  static func main() throws {
    try fixture { _, source, destination in
      let before = try Data(contentsOf: source.appendingPathComponent("relay.sqlite"))
      guard let backup = try RelayDataImporter.install(source: source, destination: destination) else { throw NSError(domain: "test", code: 2) }
      let original = try Data(contentsOf: source.appendingPathComponent("relay.sqlite"))
      let imported = try Data(contentsOf: destination.appendingPathComponent("relay.sqlite"))
      let saved = try String(contentsOf: backup.appendingPathComponent("marker"), encoding: .utf8)
      try check(original == before && imported == before && saved == "old-data", "Source or backup changed")
    }
    try fixture { _, source, destination in
      try fails { try RelayDataImporter.install(source: source, destination: destination, copy: { _, _ in throw NSError(domain: "test", code: 3) }) }
      let original = try String(contentsOf: destination.appendingPathComponent("marker"), encoding: .utf8)
      try check(original == "old-data", "Copy failure changed destination")
    }
    try fixture { _, source, destination in
      try fails {
        try RelayDataImporter.install(source: source, destination: destination, move: { from, to in
          if from.lastPathComponent.hasPrefix("Relay.import-") { throw NSError(domain: "test", code: 4) }
          try FileManager.default.moveItem(at: from, to: to)
        })
      }
      let original = try String(contentsOf: destination.appendingPathComponent("marker"), encoding: .utf8)
      try check(original == "old-data", "Failed install did not restore backup")
    }
    try fixture { root, source, destination in
      try fails { try RelayDataImporter.validate(source: source, destination: source) }
      try fails { try RelayDataImporter.validate(source: source, destination: source.appendingPathComponent("nested")) }
      let link = root.appendingPathComponent("alias")
      try FileManager.default.createSymbolicLink(at: link, withDestinationURL: source)
      try fails { try RelayDataImporter.validate(source: link, destination: source) }
      try Data(String(ProcessInfo.processInfo.processIdentifier).utf8).write(to: source.appendingPathComponent("server.lock"))
      try fails { try RelayDataImporter.validate(source: source, destination: destination) }
    }
    print("Swift import checks passed: 4 (source/backup, copy failure, rollback, overlap/live lock)")
  }
}
