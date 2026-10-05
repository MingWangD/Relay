// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "RelayApp",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "RelayApp", targets: ["RelayApp"]),
  ],
  dependencies: [
    .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
  ],
  targets: [
    .executableTarget(
      name: "RelayApp",
      dependencies: [.product(name: "Sparkle", package: "Sparkle")],
      path: "Sources/RelayApp",
      swiftSettings: [.unsafeFlags(["-parse-as-library"])],
      linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
    ),
  ]
)
