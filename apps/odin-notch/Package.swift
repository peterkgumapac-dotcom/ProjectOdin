// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ODINNotch",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "ODINNotch", targets: ["ODINNotch"])
    ],
    targets: [
        .executableTarget(
            name: "ODINNotch",
            dependencies: [
                "Sparkle"
            ],
            path: "Sources/ODINNotch"
        ),
        .binaryTarget(
            name: "Sparkle",
            path: "Vendor/Sparkle.xcframework"
        )
    ]
)
