import SwiftUI

struct NotchShape: Shape {
    var bottomCornerRadius: CGFloat = 16
    var topCornerRadius: CGFloat = 0
    var topHorizontalInset: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let bottomRadius = min(bottomCornerRadius, rect.height / 2)
        let topRadius = min(topCornerRadius, rect.height / 2)
        let topInset = min(max(topHorizontalInset, 0), rect.width / 3)

        if topInset == 0 && topRadius == 0 && bottomRadius > 0 {
            return bottomShoulderPath(in: rect, radius: bottomRadius)
        }

        var path = Path()
        path.move(to: CGPoint(x: rect.minX + topInset + topRadius, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - topInset - topRadius, y: rect.minY))
        if topRadius > 0 {
            path.addQuadCurve(
                to: CGPoint(x: rect.maxX - topInset, y: rect.minY + topRadius),
                control: CGPoint(x: rect.maxX - topInset, y: rect.minY)
            )
        }
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - bottomRadius))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX - bottomRadius, y: rect.maxY),
            control: CGPoint(x: rect.maxX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.minX + bottomRadius, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX, y: rect.maxY - bottomRadius),
            control: CGPoint(x: rect.minX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.minX + topInset, y: rect.minY + topRadius))
        if topRadius > 0 {
            path.addQuadCurve(
                to: CGPoint(x: rect.minX + topInset + topRadius, y: rect.minY),
                control: CGPoint(x: rect.minX + topInset, y: rect.minY)
            )
        }
        path.closeSubpath()
        return path
    }

    private func bottomShoulderPath(in rect: CGRect, radius: CGFloat) -> Path {
        let radius = min(radius, min(rect.width, rect.height) / 2)
        let smoothing = radius * 0.34

        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - radius))
        path.addCurve(
            to: CGPoint(x: rect.maxX - radius, y: rect.maxY),
            control1: CGPoint(x: rect.maxX, y: rect.maxY - smoothing),
            control2: CGPoint(x: rect.maxX - smoothing, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.minX + radius, y: rect.maxY))
        path.addCurve(
            to: CGPoint(x: rect.minX, y: rect.maxY - radius),
            control1: CGPoint(x: rect.minX + smoothing, y: rect.maxY),
            control2: CGPoint(x: rect.minX, y: rect.maxY - smoothing)
        )
        path.closeSubpath()
        return path
    }
}
