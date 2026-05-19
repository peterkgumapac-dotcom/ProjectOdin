import SwiftUI

struct NotchShape: Shape {
    var bottomCornerRadius: CGFloat = 14
    var topCornerRadius: CGFloat = 11
    var notchInsetFromLeft: CGFloat = 0
    var notchWidth: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let br = bottomCornerRadius
        let tr = topCornerRadius
        let hasNotchCutout = notchWidth > 0 && notchInsetFromLeft >= 0

        path.move(to: CGPoint(x: rect.minX, y: rect.minY))

        if hasNotchCutout {
            let nL = rect.minX + notchInsetFromLeft
            let nR = nL + notchWidth

            // Top edge: panel left → just before notch left edge.
            path.addLine(to: CGPoint(x: nL - tr, y: rect.minY))

            // Concave outward curve at notch's bottom-left hardware corner.
            // Pen sweeps from top edge down to notch-bottom edge,
            // hugging the hardware corner from below.
            path.addQuadCurve(
                to: CGPoint(x: nL, y: rect.minY + tr),
                control: CGPoint(x: nL, y: rect.minY)
            )

            // Bottom edge of the physical notch.
            path.addLine(to: CGPoint(x: nR, y: rect.minY + tr))

            // Concave outward curve at notch's bottom-right hardware corner.
            path.addQuadCurve(
                to: CGPoint(x: nR + tr, y: rect.minY),
                control: CGPoint(x: nR, y: rect.minY)
            )

            // Top edge: just past notch right edge → panel right.
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        } else {
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        }

        // Right side down to bottom-right convex corner.
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - br))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX - br, y: rect.maxY),
            control: CGPoint(x: rect.maxX, y: rect.maxY)
        )

        // Bottom edge → bottom-left convex corner.
        path.addLine(to: CGPoint(x: rect.minX + br, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX, y: rect.maxY - br),
            control: CGPoint(x: rect.minX, y: rect.maxY)
        )

        // Left side back to top.
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
        path.closeSubpath()

        return path
    }
}
