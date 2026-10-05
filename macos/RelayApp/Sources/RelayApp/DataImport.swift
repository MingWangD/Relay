import Foundation
import Darwin

// Import never overwrites the destination until a complete copy exists.
struct RelayDataImporter {
  private static func failure(_ message: String) -> NSError {
    NSError(domain: "RelayApp", code: 8, userInfo: [NSLocalizedDescriptionKey: message])
  }

  static func validate(source: URL, destination: URL) throws {
    let source = source.resolvingSymlinksInPath().standardizedFileURL
    let destination = destination.resolvingSymlinksInPath().standardizedFileURL
    guard source != destination,
          !source.path.hasPrefix(destination.path + "/"),
          !destination.path.hasPrefix(source.path + "/") else {
      throw failure("源数据目录与 App 数据目录不能相同或互相包含")
    }
    let database = source.appendingPathComponent("relay.sqlite")
    let handle = try FileHandle(forReadingFrom: database)
    defer { try? handle.close() }
    guard try handle.read(upToCount: 16) == Data("SQLite format 3\0".utf8) else {
      throw failure("所选目录不含有效的 relay.sqlite")
    }
    let fm = FileManager.default
    var locks = [source.appendingPathComponent("server.lock")]
    let projects = source.appendingPathComponent("projects", isDirectory: true)
    if fm.fileExists(atPath: projects.path) {
      for folder in try fm.contentsOfDirectory(at: projects, includingPropertiesForKeys: nil) {
        locks.append(folder.appendingPathComponent("server.lock"))
      }
    }
    for lock in locks where fm.fileExists(atPath: lock.path) {
      let text = try String(contentsOf: lock, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
      guard let pid = Int32(text), pid > 0 else { throw failure("源目录进程锁无效，请先核对服务状态") }
      if kill(pid, 0) == 0 || errno != ESRCH {
        throw failure("源数据目录仍有服务运行；请先退出该服务，再导入")
      }
    }
  }

  @discardableResult
  static func install(source: URL, destination: URL,
                      copy: (URL, URL) throws -> Void = { try FileManager.default.copyItem(at: $0, to: $1) },
                      move: (URL, URL) throws -> Void = { try FileManager.default.moveItem(at: $0, to: $1) }) throws -> URL? {
    try validate(source: source, destination: destination)
    let fm = FileManager.default
    let parent = destination.deletingLastPathComponent()
    try fm.createDirectory(at: parent, withIntermediateDirectories: true)
    let staging = parent.appendingPathComponent("Relay.import-\(UUID().uuidString)")
    let backup = parent.appendingPathComponent("Relay.backup-\(UUID().uuidString)")
    var backedUp = false
    do {
      try copy(source, staging)
      if fm.fileExists(atPath: destination.path) {
        try move(destination, backup)
        backedUp = true
      }
      try move(staging, destination)
      return backedUp ? backup : nil
    } catch {
      let originalError = error
      try? fm.removeItem(at: staging)
      if backedUp {
        do { try fm.moveItem(at: backup, to: destination) }
        catch { throw failure("导入失败且自动恢复未完成；备份位于 \(backup.path)") }
      }
      throw originalError
    }
  }
}
