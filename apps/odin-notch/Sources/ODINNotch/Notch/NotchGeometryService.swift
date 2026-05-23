import AppKit

struct NotchGeometry: Equatable {
    let notchX: CGFloat
    let notchY: CGFloat
    let notchWidth: CGFloat
    let notchHeight: CGFloat
    let leftSafeWidth: CGFloat
    let rightSafeWidth: CGFloat
    let menuBarHeight: CGFloat
    let screenWidth: CGFloat
    let screenHeight: CGFloat
    let hasNotch: Bool
    let screenFrame: CGRect

    var compactSize: CGSize {
        if hasNotch {
            return CGSize(width: notchWidth + 72, height: max(menuBarHeight + 8, 46))
        }
        return CGSize(width: 172, height: 46)
    }

    func compactSize(for activity: NotchLiveActivity) -> CGSize {
        let baseWidth = hasNotch ? max(notchWidth + 360, 560) : 560
        let width: CGFloat

        switch activity {
        case .resting:
            return compactSize
        case .fileDrop:
            return expandedSize
        case .songPeek:
            width = min(max(baseWidth + 20, 600), 680)
        case .calendarPeek:
            width = min(max(baseWidth + 40, 620), 720)
        case .music:
            width = min(max(baseWidth + 110, 700), 790)
        case .meeting:
            width = min(max(baseWidth + 70, 660), 760)
        case .calendarBrowse:
            width = min(max(baseWidth + 110, 700), 790)
        }

        let height: CGFloat = activity == .fileDrop ? max(menuBarHeight + 104, 142) : (hasNotch ? max(menuBarHeight + 58, 96) : 96)
        return CGSize(width: min(width, max(screenWidth - 120, 320)), height: height)
    }

    var expandedSize: CGSize {
        let width = min(max(screenWidth * 0.48, 820), 920)
        return CGSize(width: min(width, screenWidth - 80), height: 246)
    }

    func notchSurfaceLayout(in surfaceWidth: CGFloat, signalDiameter: CGFloat = 34, signalGap: CGFloat = 2) -> NotchSurfaceLayout {
        let centerX = surfaceWidth / 2
        let radius = signalDiameter / 2
        let fallbackVoidWidth: CGFloat = 150
        let rawVoidWidth = hasNotch ? notchWidth : fallbackVoidWidth
        let maxVoidWidth = max(surfaceWidth - ((radius + signalGap) * 2), 0)
        let voidWidth = min(rawVoidWidth, maxVoidWidth)
        let voidLeft = centerX - (voidWidth / 2)
        let voidRight = centerX + (voidWidth / 2)
        let leftSignalX = max(radius, voidLeft - signalGap - radius)
        let rightSignalX = min(surfaceWidth - radius, voidRight + signalGap + radius)

        return NotchSurfaceLayout(
            protectedVoidLeft: voidLeft,
            protectedVoidRight: voidRight,
            protectedVoidWidth: voidWidth,
            leftSignalCenterX: leftSignalX,
            rightSignalCenterX: rightSignalX
        )
    }
}

struct NotchSurfaceLayout: Equatable {
    let protectedVoidLeft: CGFloat
    let protectedVoidRight: CGFloat
    let protectedVoidWidth: CGFloat
    let leftSignalCenterX: CGFloat
    let rightSignalCenterX: CGFloat
}

enum NotchGeometryService {
    static func current(for screen: NSScreen? = NSScreen.main) -> NotchGeometry {
        guard let screen else {
            return NotchGeometry(
                notchX: 0,
                notchY: 0,
                notchWidth: 0,
                notchHeight: 0,
                leftSafeWidth: 0,
                rightSafeWidth: 0,
                menuBarHeight: NSStatusBar.system.thickness,
                screenWidth: 1440,
                screenHeight: 900,
                hasNotch: false,
                screenFrame: CGRect(x: 0, y: 0, width: 1440, height: 900)
            )
        }

        let frame = screen.frame
        let inset = screen.safeAreaInsets.top
        let leftArea = screen.auxiliaryTopLeftArea ?? .zero
        let rightArea = screen.auxiliaryTopRightArea ?? .zero
        let hasNotch = inset > 0 && leftArea.width > 0 && rightArea.width > 0
        let notchWidth = hasNotch ? max(frame.width - leftArea.width - rightArea.width, 0) : 0
        let notchX = hasNotch ? frame.minX + leftArea.width : frame.midX
        let menuBarHeight = max(inset, NSStatusBar.system.thickness)

        let geometry = NotchGeometry(
            notchX: notchX,
            notchY: 0,
            notchWidth: notchWidth,
            notchHeight: inset,
            leftSafeWidth: leftArea.width,
            rightSafeWidth: rightArea.width,
            menuBarHeight: menuBarHeight,
            screenWidth: frame.width,
            screenHeight: frame.height,
            hasNotch: hasNotch,
            screenFrame: frame
        )

        NSLog("ODINNotch geometry: notchX=\(geometry.notchX), notchWidth=\(geometry.notchWidth), notchHeight=\(geometry.notchHeight), menuBarHeight=\(geometry.menuBarHeight), screen=\(geometry.screenWidth)x\(geometry.screenHeight), hasNotch=\(geometry.hasNotch)")
        return geometry
    }
}
