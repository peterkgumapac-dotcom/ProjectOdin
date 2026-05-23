import SwiftUI

enum ODINDesign {
    static let black = Color.black
    static let panelStroke = Color.white.opacity(0.08)
    static let card = Color.white.opacity(0.055)
    static let cardHover = Color.white.opacity(0.10)
    static let amber = Color(red: 0.96, green: 0.58, blue: 0.18)
    static let red = Color(red: 0.96, green: 0.30, blue: 0.30)
    static let primary = Color.white
    static let secondary = Color.white.opacity(0.62)
    static let tertiary = Color.white.opacity(0.36)

    static let tight: CGFloat = 4
    static let normal: CGFloat = 8
    static let comfy: CGFloat = 16
    static let section: CGFloat = 24

    static let radiusSmall: CGFloat = 10
    static let radiusMedium: CGFloat = 12
    static let radiusLarge: CGFloat = 16
}
