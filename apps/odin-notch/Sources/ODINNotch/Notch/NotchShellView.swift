import SwiftUI
import UniformTypeIdentifiers

struct NotchShellView: View {
    @ObservedObject var model: NotchModel
    var onSettings: () -> Void
    @State private var isFileDropTargeted = false

    var body: some View {
        ZStack(alignment: .top) {
            let shellShape = NotchShape(
                bottomCornerRadius: model.presentation.isExpanded ? 58 : 28,
                topCornerRadius: model.presentation.isExpanded ? 0 : 28,
                topHorizontalInset: 0
            )

            shellShape
                .fill(ODINDesign.black)
                .overlay {
                    if model.presentation.isExpanded {
                        shellShape.stroke(ODINDesign.panelStroke, lineWidth: 1)
                    }
                }

            switch model.presentation {
            case .compact:
                CompactNotchView(model: model)
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .scale(scale: 0.98, anchor: .top)),
                        removal: .opacity.combined(with: .scale(scale: 0.94, anchor: .top))
                    ))
            case .expanded(let section), .detail(let section):
                ExpandedNotchView(model: model, section: section, onSettings: onSettings)
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .move(edge: .top)),
                        removal: .opacity.combined(with: .scale(scale: 0.98, anchor: .top))
                    ))
            case .settings:
                ExpandedNotchView(model: model, section: .odin, onSettings: onSettings)
            }

            if model.showDebugOverlay {
                DebugGeometryOverlay(geometry: model.geometry)
                    .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.spring(response: 0.42, dampingFraction: 0.84), value: model.presentation.isExpanded)
        .fileDropPromptTarget(
            enabled: model.liveActivity != .fileDrop,
            isTargeted: $isFileDropTargeted
        ) { providers in
            model.holdDroppedFiles(providers)
        }
        .onChange(of: isFileDropTargeted) { targeted in
            if targeted {
                model.enterFileDropMode()
            } else {
                model.scheduleFileDropDismissIfEmpty()
            }
        }
    }
}

private struct FileDropPromptTarget: ViewModifier {
    let enabled: Bool
    @Binding var isTargeted: Bool
    let perform: ([NSItemProvider]) -> Bool

    func body(content: Content) -> some View {
        if enabled {
            content.onDrop(of: [UTType.fileURL.identifier], isTargeted: $isTargeted, perform: perform)
        } else {
            content
        }
    }
}

private extension View {
    func fileDropPromptTarget(
        enabled: Bool,
        isTargeted: Binding<Bool>,
        perform: @escaping ([NSItemProvider]) -> Bool
    ) -> some View {
        modifier(FileDropPromptTarget(enabled: enabled, isTargeted: isTargeted, perform: perform))
    }
}

private struct DebugGeometryOverlay: View {
    let geometry: NotchGeometry

    var body: some View {
        Text("notch \(Int(geometry.notchWidth))x\(Int(geometry.notchHeight)) · menu \(Int(geometry.menuBarHeight))")
            .font(.system(size: 9, weight: .medium, design: .monospaced))
            .foregroundColor(.white.opacity(0.45))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.white.opacity(0.08), in: Capsule())
    }
}
