import SwiftUI
import UniformTypeIdentifiers

struct CompactNotchView: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        Group {
            switch model.liveActivity {
            case .calendarPeek:
                CalendarPeekCompactActivity(model: model)
            case .songPeek:
                SongPeekCompactActivity(model: model)
            case .fileDrop:
                FileDropCompactActivity(model: model)
            default:
                RestingCompactActivity(model: model)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture {
            if model.liveActivity == .calendarPeek {
                model.presentation = .expanded(.calendar)
            } else if model.liveActivity == .songPeek {
                model.presentation = .expanded(.odin)
            } else {
                model.expand()
            }
        }
    }
}

private struct FileDropCompactActivity: View {
    @ObservedObject var model: NotchModel
    @State private var isTargeted = false
    @State private var mode: FileDropMode?

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Button(action: {
                    if mode == nil {
                        model.returnFromFileDropToOverview()
                    } else {
                        mode = nil
                    }
                }) {
                    Label(mode == nil ? "Back" : "Choose", systemImage: "chevron.left")
                        .font(.system(size: 10, weight: .black))
                        .foregroundStyle(ODINDesign.primary)
                        .padding(.horizontal, 10)
                        .frame(height: 24)
                        .background(.white.opacity(0.08), in: Capsule())
                }
                .buttonStyle(.plain)

                HStack(spacing: 8) {
                    Circle()
                        .fill(ODINDesign.amber)
                        .frame(width: 7, height: 7)
                        .shadow(color: ODINDesign.amber.opacity(0.65), radius: 8)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(mode?.title ?? "FILE DROP")
                            .font(.system(size: 9, weight: .black))
                            .tracking(1.6)
                        Text(mode?.subtitle ?? "choose corkboard or ODIN drop")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.white.opacity(0.45))
                    }
                }
                .foregroundStyle(ODINDesign.primary)

                Spacer()

                if mode == .corkboard {
                    Button(action: model.addCorkNote) {
                        Label("Note", systemImage: "note.text.badge.plus")
                            .font(.system(size: 10, weight: .black))
                            .foregroundStyle(ODINDesign.primary)
                            .padding(.horizontal, 10)
                            .frame(height: 24)
                            .background(.white.opacity(0.08), in: Capsule())
                    }
                    .buttonStyle(.plain)

                    Button(action: model.chooseFilesForCorkBoard) {
                        Label("File", systemImage: "plus")
                            .font(.system(size: 10, weight: .black))
                            .foregroundStyle(.black)
                            .padding(.horizontal, 10)
                            .frame(height: 24)
                            .background(ODINDesign.amber, in: Capsule())
                    }
                    .buttonStyle(.plain)
                } else if mode == .kde {
                    Button(action: model.chooseFileForOdinDrop) {
                        Label("Send file", systemImage: "paperplane.fill")
                            .font(.system(size: 10, weight: .black))
                            .foregroundStyle(.black)
                            .padding(.horizontal, 10)
                            .frame(height: 24)
                            .background(ODINDesign.amber, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 22)

            Group {
                switch mode {
                case .none:
                    FileDropChoiceSurface(
                        choose: { selected in
                            mode = selected
                        },
                        pinFiles: { providers in
                        mode = .corkboard
                        return model.holdDroppedFiles(providers)
                    },
                    sendFiles: { providers in
                        mode = .kde
                        return model.sendDroppedFilesToPhone(providers)
                    }
                )
            case .some(.corkboard):
                CorkBoardSurface(model: model, isTargeted: isTargeted)
                    .onDrop(of: [UTType.fileURL.identifier], isTargeted: $isTargeted) { providers in
                            model.holdDroppedFiles(providers)
                        }
            case .some(.kde):
                OdinDroppingSurface(isTargeted: isTargeted, status: model.odinDropStatus)
                    .onDrop(of: [UTType.fileURL.identifier], isTargeted: $isTargeted) { providers in
                            model.sendDroppedFilesToPhone(providers)
                        }
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 10)
        .padding(.bottom, 14)
    }
}

private enum FileDropMode {
    case corkboard
    case kde

    var title: String {
        switch self {
        case .corkboard: return "CORK BOARD"
        case .kde: return "ODIN DROP"
        }
    }

    var subtitle: String {
        switch self {
        case .corkboard: return "pin notes, photos, files"
        case .kde: return "drop once, send to phone"
        }
    }
}

private struct FileDropChoiceSurface: View {
    let choose: (FileDropMode) -> Void
    let pinFiles: ([NSItemProvider]) -> Bool
    let sendFiles: ([NSItemProvider]) -> Bool
    @State private var corkTargeted = false
    @State private var kdeTargeted = false

    var body: some View {
        HStack(spacing: 14) {
            FileDropChoiceCard(
                title: "Cork Board",
                subtitle: corkTargeted ? "Release to pin here" : "Pin notes, photos, files",
                icon: "pin.fill",
                accent: ODINDesign.amber,
                isTargeted: corkTargeted
            ) {
                choose(.corkboard)
            }
            .onDrop(of: [UTType.fileURL.identifier], isTargeted: $corkTargeted) { providers in
                pinFiles(providers)
            }

            FileDropChoiceCard(
                title: "ODIN Drop",
                subtitle: kdeTargeted ? "Release to send now" : "Send one file to phone",
                icon: "dot.radiowaves.left.and.right",
                accent: ODINDesign.amber,
                isTargeted: kdeTargeted
            ) {
                choose(.kde)
            }
            .onDrop(of: [UTType.fileURL.identifier], isTargeted: $kdeTargeted) { providers in
                sendFiles(providers)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.black.opacity(0.70), in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(ODINDesign.amber.opacity(0.18), lineWidth: 1))
    }
}

private struct FileDropChoiceCard: View {
    let title: String
    let subtitle: String
    let icon: String
    let accent: Color
    let isTargeted: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 9) {
                Image(systemName: icon)
                    .font(.system(size: 24, weight: .black))
                    .foregroundStyle(accent)
                    .frame(width: 46, height: 46)
                    .background(accent.opacity(0.14), in: Circle())

                Text(title)
                    .font(.system(size: 14, weight: .black))
                    .foregroundStyle(ODINDesign.primary)

                Text(subtitle)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white.opacity(0.50))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background((isTargeted ? accent.opacity(0.18) : .white.opacity(0.055)), in: RoundedRectangle(cornerRadius: 18))
            .overlay {
                RoundedRectangle(cornerRadius: 18)
                    .stroke(
                        style: StrokeStyle(lineWidth: isTargeted ? 2 : 1, dash: isTargeted ? [9, 7] : [])
                    )
                    .foregroundStyle(accent.opacity(isTargeted ? 0.90 : 0.24))
            }
        }
        .buttonStyle(.plain)
        .scaleEffect(isTargeted ? 1.018 : 1)
        .animation(.spring(response: 0.22, dampingFraction: 0.86), value: isTargeted)
    }
}

private struct OdinDroppingSurface: View {
    let isTargeted: Bool
    let status: OdinDropStatus

    var body: some View {
        VStack(spacing: 12) {
            ZStack {
                Image(systemName: status.isVisible ? status.icon : "dot.radiowaves.left.and.right")
                    .font(.system(size: 30, weight: .black))
                    .foregroundStyle(isTargeted ? .black : ODINDesign.amber)
                    .frame(width: 58, height: 58)
                    .background((isTargeted ? ODINDesign.amber : ODINDesign.amber.opacity(0.16)), in: Circle())

                if case .sending = status {
                    ProgressView()
                        .scaleEffect(0.56)
                        .offset(x: 28, y: -24)
                }
            }

            VStack(spacing: 4) {
                Text(status.isVisible ? status.title : (isTargeted ? "Release to send to phone" : "Drop a file here"))
                    .font(.system(size: 15, weight: .black))
                    .foregroundStyle(status.isFailed ? Color.red.opacity(0.92) : ODINDesign.primary)
                    .lineLimit(1)
                Text(status.isVisible ? status.text : "ODIN Drop will send it directly to your paired phone.")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white.opacity(0.52))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            LinearGradient(
                colors: [ODINDesign.amber.opacity(0.18), Color.black.opacity(0.72)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 20)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 20)
                .stroke(style: StrokeStyle(lineWidth: isTargeted ? 2 : 1, dash: isTargeted ? [10, 7] : []))
                .foregroundStyle(ODINDesign.amber.opacity(isTargeted ? 0.88 : 0.32))
        }
        .scaleEffect(isTargeted ? 1.018 : 1)
        .animation(.spring(response: 0.22, dampingFraction: 0.86), value: isTargeted)
        .animation(.spring(response: 0.24, dampingFraction: 0.86), value: status)
    }
}

private struct CorkBoardSurface: View {
    @ObservedObject var model: NotchModel
    let isTargeted: Bool

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: 4)

    var body: some View {
        ZStack(alignment: .topLeading) {
            CorkBoardTexture()

            if model.corkNotes.isEmpty && model.clippedFiles.isEmpty {
                CorkEmptyCard(isTargeted: isTargeted)
                    .padding(18)
            }

            ScrollView(.vertical, showsIndicators: false) {
                LazyVGrid(columns: columns, spacing: 14) {
                    ForEach($model.corkNotes) { $note in
                        CorkNoteCard(note: $note) {
                            model.removeCorkNote(note)
                        }
                    }

                    ForEach(model.clippedFiles) { file in
                        CorkFileCard(file: file, sendStatus: model.odinDropStatus) {
                            model.sendClippedFileToPhone(file)
                        } remove: {
                            model.removeClippedFile(file)
                        }
                    }
                }
                .padding(18)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .overlay {
            RoundedRectangle(cornerRadius: 20)
                .stroke(style: StrokeStyle(lineWidth: isTargeted ? 2 : 1, dash: isTargeted ? [9, 7] : []))
                .foregroundStyle(isTargeted ? Color.blue.opacity(0.85) : ODINDesign.amber.opacity(0.24))
        }
        .overlay(alignment: .bottomTrailing) {
            Button(action: model.chooseFileForOdinDrop) {
                HStack(spacing: 7) {
                    Image(systemName: "dot.radiowaves.left.and.right")
                        .font(.system(size: 10, weight: .black))
                    Text("ODIN Drop")
                        .font(.system(size: 8, weight: .heavy))
                }
                .foregroundStyle(.black.opacity(0.72))
                .padding(.horizontal, 10)
                .frame(height: 24)
                .background(Color(red: 0.98, green: 0.64, blue: 0.20).opacity(0.90), in: Capsule())
            }
            .buttonStyle(.plain)
            .padding(12)
        }
        .overlay(alignment: .bottomLeading) {
            OdinDropStatusBadge(status: model.odinDropStatus)
                .padding(12)
        }
    }
}

private struct CorkBoardTexture: View {
    var body: some View {
        Canvas { context, size in
            context.fill(
                Path(CGRect(origin: .zero, size: size)),
                with: .linearGradient(
                    Gradient(colors: [
                        Color(red: 0.56, green: 0.34, blue: 0.16),
                        Color(red: 0.33, green: 0.18, blue: 0.075),
                        Color(red: 0.18, green: 0.10, blue: 0.045)
                    ]),
                    startPoint: .zero,
                    endPoint: CGPoint(x: size.width, y: size.height)
                )
            )

            for index in 0..<180 {
                let x = CGFloat((index * 47) % max(Int(size.width), 1))
                let y = CGFloat((index * 29) % max(Int(size.height), 1))
                let diameter = CGFloat(1 + (index % 4))
                let opacity = 0.07 + Double(index % 5) * 0.018
                let rect = CGRect(x: x, y: y, width: diameter, height: diameter)
                context.fill(Path(ellipseIn: rect), with: .color(.white.opacity(opacity)))
            }

            for index in 0..<72 {
                let x = CGFloat((index * 83) % max(Int(size.width), 1))
                let y = CGFloat((index * 37) % max(Int(size.height), 1))
                let rect = CGRect(x: x, y: y, width: CGFloat(6 + index % 9), height: 1)
                context.fill(Path(roundedRect: rect, cornerRadius: 0.5), with: .color(.black.opacity(0.10)))
            }
        }
        .overlay(
            RadialGradient(
                colors: [.black.opacity(0.02), .black.opacity(0.42)],
                center: .center,
                startRadius: 20,
                endRadius: 520
            )
        )
    }
}

private struct CorkNoteCard: View {
    @Binding var note: CorkNote
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                PushPin(color: Color(red: 0.95, green: 0.33, blue: 0.22))
                Spacer()
                Button(action: remove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .black))
                        .foregroundStyle(.black.opacity(0.62))
                }
                .buttonStyle(.plain)
            }

            TextField("New note", text: $note.text)
                .textFieldStyle(.plain)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(.black.opacity(0.82))
                .lineLimit(2)
        }
        .padding(10)
        .frame(minHeight: 88, alignment: .topLeading)
        .background(Color(red: 1.0, green: 0.80, blue: 0.30), in: RoundedRectangle(cornerRadius: 8))
        .shadow(color: .black.opacity(0.24), radius: 7, x: 0, y: 4)
        .rotationEffect(.degrees(-1.4))
    }
}

private struct CorkFileCard: View {
    let file: ClippedFile
    let sendStatus: OdinDropStatus
    let send: () -> Void
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ZStack(alignment: .topLeading) {
                if file.isImage, let image = NSImage(contentsOf: file.url) {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(maxWidth: .infinity)
                        .frame(height: 66)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                } else {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color(red: 0.95, green: 0.89, blue: 0.77))
                        .frame(maxWidth: .infinity)
                        .frame(height: 66)
                    Image(systemName: file.systemImage)
                        .font(.system(size: 24, weight: .bold))
                        .foregroundStyle(.black.opacity(0.55))
                }
                PushPin(color: ODINDesign.amber)
                    .padding(6)
            }

            HStack(spacing: 7) {
                Text(file.name)
                    .font(.system(size: 10, weight: .black))
                    .foregroundStyle(.black.opacity(0.78))
                    .lineLimit(1)
                Spacer(minLength: 0)
                Button(action: send) {
                    Image(systemName: sendStatus.isVisible ? sendStatus.icon : "paperplane.fill")
                }
                    .buttonStyle(.plain)
                Button(action: remove) { Image(systemName: "xmark") }
                    .buttonStyle(.plain)
            }
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.black.opacity(0.58))
        }
        .padding(8)
        .frame(minHeight: 104, alignment: .topLeading)
        .background(Color(red: 0.98, green: 0.94, blue: 0.84), in: RoundedRectangle(cornerRadius: 10))
        .shadow(color: .black.opacity(0.25), radius: 7, x: 0, y: 4)
        .rotationEffect(.degrees(1.0))
    }
}

private struct OdinDropStatusBadge: View {
    let status: OdinDropStatus

    var body: some View {
        if status.isVisible {
            HStack(spacing: 7) {
                Image(systemName: status.icon)
                    .font(.system(size: 10, weight: .black))
                VStack(alignment: .leading, spacing: 0) {
                    Text(status.title)
                        .font(.system(size: 8, weight: .black))
                    Text(status.text)
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.white.opacity(0.62))
                        .lineLimit(1)
                }
            }
            .foregroundStyle(status.isFailed ? Color.red.opacity(0.95) : ODINDesign.primary)
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(.black.opacity(0.70), in: Capsule())
            .overlay(Capsule().stroke((status.isFailed ? Color.red : ODINDesign.amber).opacity(0.34), lineWidth: 1))
            .transition(.opacity.combined(with: .scale(scale: 0.96)))
        }
    }
}

private struct PushPin: View {
    let color: Color

    var body: some View {
        ZStack {
            Circle()
                .fill(color)
                .frame(width: 12, height: 12)
                .shadow(color: .black.opacity(0.25), radius: 3, x: 0, y: 2)
            Circle()
                .fill(.white.opacity(0.28))
                .frame(width: 4, height: 4)
                .offset(x: -2, y: -2)
        }
    }
}

private struct CorkEmptyCard: View {
    let isTargeted: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Image(systemName: "tray.full.fill")
                .font(.system(size: 20, weight: .black))
            Text(isTargeted ? "Release to pin it" : "Drop files or photos here")
                .font(.system(size: 13, weight: .black))
            Text("Use + Note for sticky notes. Use + File to pin from Finder.")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.black.opacity(0.50))
        }
        .foregroundStyle(.black.opacity(0.76))
        .padding(14)
        .frame(width: 230, height: 96, alignment: .leading)
        .background(Color(red: 1.0, green: 0.82, blue: 0.35), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(style: StrokeStyle(lineWidth: isTargeted ? 2 : 1, dash: [7, 6]))
                .foregroundStyle(isTargeted ? Color.blue.opacity(0.82) : .black.opacity(0.16))
        }
        .rotationEffect(.degrees(-0.8))
        .shadow(color: .black.opacity(0.24), radius: 8, x: 0, y: 5)
    }
}

private struct CorkActionCard: View {
    let title: String
    let icon: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.system(size: 18, weight: .black))
                Text(title)
                    .font(.system(size: 10, weight: .black))
            }
            .foregroundStyle(ODINDesign.amber)
            .frame(maxWidth: .infinity, minHeight: 74)
            .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(.white.opacity(0.08), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

private struct KDEBoardCard: View {
    @State private var isTargeted = false

    var body: some View {
        Button(action: PhoneDropService.chooseAndSendFile) {
            VStack(spacing: 7) {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .font(.system(size: 18, weight: .black))
                Text(isTargeted ? "Send now" : "ODIN Drop")
                    .font(.system(size: 10, weight: .black))
            }
            .foregroundStyle(isTargeted ? .black : ODINDesign.amber)
            .frame(maxWidth: .infinity, minHeight: 74)
            .background(isTargeted ? ODINDesign.amber : .white.opacity(0.055), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(ODINDesign.amber.opacity(isTargeted ? 0.50 : 0.16), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .onDrop(of: [UTType.fileURL.identifier], isTargeted: $isTargeted) { providers in
            PhoneDropService.share(itemProviders: providers)
        }
    }
}

private struct CorkBoardDropZone: View {
    @ObservedObject var model: NotchModel
    let isTargeted: Bool

    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 5) {
                Image(systemName: "tray.full.fill")
                    .font(.system(size: 20, weight: .black))
                Text("Files Tray")
                    .font(.system(size: 12, weight: .black))
                Text(model.clippedFiles.isEmpty ? "Drop to pin" : "Pinned until deleted")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white.opacity(0.46))
            }
            .foregroundStyle(isTargeted ? ODINDesign.primary : ODINDesign.amber)
            .frame(width: 88, alignment: .leading)

            if model.clippedFiles.isEmpty {
                VStack(spacing: 5) {
                    Image(systemName: "doc.badge.plus")
                        .font(.system(size: 24, weight: .bold))
                    Text("Cork board")
                        .font(.system(size: 10, weight: .heavy))
                }
                .foregroundStyle(.white.opacity(0.34))
                .frame(maxWidth: .infinity)
            } else {
                HStack(spacing: 8) {
                    ForEach(model.clippedFiles.prefix(2)) { file in
                        HeldFileChip(file: file) {
                            model.removeClippedFile(file)
                        } send: {
                            model.sendClippedFileToPhone(file)
                        }
                    }
                    if model.clippedFiles.count > 2 {
                        Text("+\(model.clippedFiles.count - 2)")
                            .font(.system(size: 10, weight: .black))
                            .foregroundStyle(ODINDesign.secondary)
                            .padding(.horizontal, 8)
                            .frame(height: 28)
                            .background(.black.opacity(0.45), in: Capsule())
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(.white.opacity(isTargeted ? 0.08 : 0.045), in: RoundedRectangle(cornerRadius: 20))
        .overlay {
            RoundedRectangle(cornerRadius: 22)
                .stroke(style: StrokeStyle(lineWidth: 2, dash: [9, 7]))
                .foregroundStyle(ODINDesign.amber.opacity(isTargeted ? 0.90 : 0.42))
        }
        .scaleEffect(isTargeted ? 1.025 : 1)
        .animation(.spring(response: 0.24, dampingFraction: 0.82), value: isTargeted)
    }
}

private struct KDEDropZone: View {
    let isTargeted: Bool

    var body: some View {
        Button(action: PhoneDropService.chooseAndSendFile) {
            HStack(spacing: 14) {
                ZStack {
                    Circle()
                        .fill(ODINDesign.amber.opacity(isTargeted ? 0.22 : 0.12))
                        .frame(width: 44, height: 44)
                    Image(systemName: "dot.radiowaves.left.and.right")
                        .font(.system(size: 20, weight: .heavy))
                        .foregroundStyle(ODINDesign.amber)
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text("ODIN Drop")
                        .font(.system(size: 13, weight: .black))
                    Text(isTargeted ? "Release to send" : "Send to phone")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white.opacity(0.58))
                }

                Spacer()
            }
            .foregroundStyle(ODINDesign.primary)
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(.white.opacity(isTargeted ? 0.10 : 0.055), in: RoundedRectangle(cornerRadius: 20))
            .overlay {
                RoundedRectangle(cornerRadius: 20)
                    .stroke((isTargeted ? ODINDesign.amber : Color.white).opacity(isTargeted ? 0.42 : 0.07), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .scaleEffect(isTargeted ? 1.025 : 1)
        .animation(.spring(response: 0.24, dampingFraction: 0.82), value: isTargeted)
    }
}

private struct HeldFileChip: View {
    let file: ClippedFile
    let remove: () -> Void
    let send: () -> Void

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: file.systemImage)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(ODINDesign.amber)
            Text(file.name)
                .font(.system(size: 10, weight: .heavy))
                .foregroundStyle(ODINDesign.primary)
                .lineLimit(1)
            Button(action: send) {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 9, weight: .bold))
            }
            .buttonStyle(.plain)
            Button(action: remove) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .black))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 9)
        .frame(height: 28)
        .background(.black.opacity(0.58), in: Capsule())
        .overlay(Capsule().stroke(.white.opacity(0.10), lineWidth: 1))
    }
}

private struct NotchSafeWingLayout<Left: View, Right: View>: View {
    @ObservedObject var model: NotchModel
    @ViewBuilder var left: Left
    @ViewBuilder var right: Right

    var body: some View {
        GeometryReader { proxy in
            let horizontalPadding: CGFloat = 24
            let deadZone = model.geometry.hasNotch ? max(model.geometry.notchWidth + 40, 190) : 28
            let usable = max(proxy.size.width - (horizontalPadding * 2) - deadZone, 0)
            let wingWidth = usable / 2

            HStack(spacing: 0) {
                left
                    .frame(width: wingWidth, alignment: .leading)

                Color.clear
                    .frame(width: deadZone)
                    .accessibilityHidden(true)

                right
                    .frame(width: wingWidth, alignment: .trailing)
            }
            .padding(.horizontal, horizontalPadding)
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .center)
        }
    }
}

private struct RestingCompactActivity: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        GeometryReader { proxy in
            let layout = model.geometry.notchSurfaceLayout(in: proxy.size.width, signalDiameter: 34, signalGap: 2)
            let centerY = proxy.size.height / 2

            ZStack {
                Color.clear
                    .frame(width: layout.protectedVoidWidth, height: proxy.size.height)
                    .position(x: proxy.size.width / 2, y: centerY)
                    .accessibilityHidden(true)

                NotchSideOrb(systemName: "circle.fill", isActive: true, size: 34, pulseSize: 13, music: model.music)
                    .position(x: layout.leftSignalCenterX, y: centerY)

                NotchSideOrb(systemName: "circle.fill", isActive: true, size: 34, pulseSize: 13, music: model.music)
                    .position(x: layout.rightSignalCenterX, y: centerY)
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
    }
}

private struct RestingStatusOrb: View {
    let music: MusicState

    var body: some View {
        TimelineView(.animation) { timeline in
            let reactive = AudioReactiveEngine.state(for: music, at: timeline.date)
            let dotSize = reactive.isReactive ? 5 + (reactive.beatPulse * 3) : 5
            let glow = reactive.isReactive ? 0.55 + (reactive.glow * 0.35) : 0.65

            ZStack {
                Circle()
                    .fill(.black)
                    .frame(width: 22, height: 22)
                    .overlay(Circle().stroke(.white.opacity(0.035), lineWidth: 1))
                    .shadow(color: ODINDesign.amber.opacity(reactive.isReactive ? 0.18 : 0.10), radius: reactive.isReactive ? 11 : 8)

                Circle()
                    .fill(ODINDesign.amber)
                    .frame(width: dotSize, height: dotSize)
                    .shadow(color: ODINDesign.amber.opacity(glow), radius: reactive.isReactive ? 9 : 6)
            }
        }
    }
}

private struct MusicCompactActivity: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        NotchSafeWingLayout(model: model) {
            HStack(spacing: 12) {
                NotchSideOrb(systemName: "circle.fill", isActive: true, size: 44, pulseSize: 14, music: model.music)

                AlbumArtBadge(music: model.music)
                    .frame(width: 48, height: 48)

                VStack(alignment: .leading, spacing: 5) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(model.music.isAvailable ? model.music.title : "Spotify idle")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(ODINDesign.primary)
                            .lineLimit(1)
                        Text(model.music.isAvailable ? model.music.artist : "Open Spotify")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(ODINDesign.secondary)
                            .lineLimit(1)
                    }

                    HStack(spacing: 7) {
                        CompactTransportButton(systemName: "backward.end.fill", action: model.skipToPreviousTrack)
                        CompactTransportButton(systemName: model.music.isPlaying ? "pause.fill" : "play.fill", action: model.toggleMusicPlayback)
                        CompactTransportButton(systemName: "forward.end.fill", action: model.skipToNextTrack)
                    }
                }
            }
        } right: {
            HStack(spacing: 12) {
                ProgressView(value: model.music.progress)
                    .progressViewStyle(.linear)
                    .tint(ODINDesign.amber)
                    .frame(maxWidth: 130)

                NotchSideOrb(systemName: "waveform", isActive: model.music.isPlaying, size: 44, pulseSize: 14, music: model.music)
            }
        }
    }
}

private struct MeetingCompactActivity: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        NotchSafeWingLayout(model: model) {
            HStack(spacing: 12) {
                NotchSideOrb(systemName: "circle", isActive: false)
                CapsuleInfo(icon: "calendar", text: model.meetings.first?.time ?? "--")
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.meetings.first?.title ?? "No meeting")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(ODINDesign.primary)
                        .lineLimit(1)
                    Text("in 12m · \(model.meetings.first?.timezone.replacingOccurrences(of: "America/", with: "") ?? "local")")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(ODINDesign.secondary)
                        .lineLimit(1)
                }
            }
        } right: {
            Button(action: { model.expand() }) {
                Label("Join", systemImage: "video.fill")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(ODINDesign.primary)
                    .padding(.horizontal, 12)
                    .frame(height: 30)
                    .background(.white.opacity(0.08), in: Capsule())
            }
            .buttonStyle(.plain)
        }
    }
}

private struct CalendarBrowseCompactActivity: View {
    private let days = ["S", "M", "T", "W", "T", "F", "S"]
    private let dates = ["16", "17", "18", "19", "20", "21", "22"]

    @ObservedObject var model: NotchModel

    var body: some View {
        NotchSafeWingLayout(model: model) {
            HStack(spacing: 12) {
                NotchSideOrb(systemName: "circle", isActive: false)
                Button(action: {}) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(ODINDesign.secondary)
                }
                .buttonStyle(.plain)

                Text("June 2025")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ODINDesign.primary)
            }
        } right: {
            HStack(spacing: 10) {
                HStack(spacing: 9) {
                    ForEach(Array(zip(days.indices, days)), id: \.0) { index, day in
                        VStack(spacing: 3) {
                            Text(day)
                                .font(.system(size: 8, weight: .medium))
                                .foregroundStyle(ODINDesign.tertiary)
                            Text(dates[index])
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(index == 2 ? .black : ODINDesign.secondary)
                                .frame(width: 22, height: 22)
                                .background(index == 2 ? ODINDesign.amber : .clear, in: Circle())
                        }
                    }
                }

                Button(action: {}) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(ODINDesign.secondary)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

private struct CalendarPeekCompactActivity: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        NotchSafeWingLayout(model: model) {
            HStack(spacing: 12) {
                NotchSideOrb(systemName: "calendar", isActive: true, size: 34, pulseSize: 12, music: model.music)

                VStack(alignment: .leading, spacing: 5) {
                    Text(relativeTitle)
                        .font(.system(size: 13, weight: .heavy))
                        .foregroundStyle(ODINDesign.secondary)
                        .lineLimit(1)

                    Text(meeting?.time ?? "--")
                        .font(.system(size: 20, weight: .black))
                        .foregroundStyle(ODINDesign.amber)
                        .lineLimit(1)
                }
            }
        } right: {
            VStack(alignment: .leading, spacing: 4) {
                Text(meeting?.title ?? "No upcoming event")
                    .font(.system(size: 14, weight: .heavy))
                    .foregroundStyle(ODINDesign.primary)
                    .lineLimit(1)

                Text(meeting?.timezone.replacingOccurrences(of: "America/", with: "") ?? TimeZone.current.identifier)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(ODINDesign.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .transition(.move(edge: .trailing).combined(with: .opacity))
    }

    private var meeting: MeetingItem? {
        model.calendarPeekMeeting ?? model.meetings
            .filter { $0.startDate > Date() }
            .sorted { $0.startDate < $1.startDate }
            .first
    }

    private var relativeTitle: String {
        guard let meeting else { return "Calendar peek" }
        let minutes = max(Int(ceil(meeting.startDate.timeIntervalSince(Date()) / 60)), 0)
        if minutes < 1 { return "Event starting now" }
        if minutes < 60 { return "Next event in \(minutes)m" }
        let hours = minutes / 60
        let remainder = minutes % 60
        return remainder == 0 ? "Next event in \(hours)h" : "Next event in \(hours)h \(remainder)m"
    }
}

private struct SongPeekCompactActivity: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        NotchSafeWingLayout(model: model) {
            HStack(spacing: 12) {
                AlbumArtBadge(music: track)
                    .frame(width: 54, height: 54)
                    .shadow(color: .black.opacity(0.35), radius: 10, y: 4)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(track.isPlaying ? Color(red: 0.12, green: 0.78, blue: 0.34) : ODINDesign.amber)
                            .frame(width: 6, height: 6)
                            .shadow(color: (track.isPlaying ? Color(red: 0.12, green: 0.78, blue: 0.34) : ODINDesign.amber).opacity(0.6), radius: 7)

                        Text(track.isPlaying ? "NOW PLAYING" : "PLAYING NEXT")
                            .font(.system(size: 8, weight: .black))
                            .tracking(1.3)
                            .foregroundStyle(ODINDesign.tertiary)
                    }

                    Text(trackTitle)
                        .font(.system(size: 16, weight: .black))
                        .foregroundStyle(ODINDesign.primary)
                        .lineLimit(1)

                    Text(trackArtist)
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(ODINDesign.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .id(trackTitle + trackArtist)
                .transition(.asymmetric(
                    insertion: .move(edge: .trailing).combined(with: .opacity),
                    removal: .move(edge: .leading).combined(with: .opacity)
                ))
            }
        } right: {
            HStack(spacing: 14) {
                ProgressView(value: track.progress)
                    .progressViewStyle(.linear)
                    .tint(ODINDesign.amber)
                    .frame(width: 118)

                NotchSideOrb(systemName: "waveform", isActive: track.isPlaying, size: 34, pulseSize: 12, music: track)
            }
        }
        .transition(.asymmetric(
            insertion: .move(edge: .leading).combined(with: .opacity),
            removal: .move(edge: .leading).combined(with: .opacity)
        ))
        .animation(.spring(response: 0.34, dampingFraction: 0.78), value: trackTitle + trackArtist)
    }

    private var track: MusicState {
        model.songPeekTrack ?? model.music
    }

    private var trackTitle: String {
        track.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Track changed" : track.title
    }

    private var trackArtist: String {
        track.artist.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Spotify" : track.artist
    }
}

private struct NotchSideOrb: View {
    let systemName: String
    let isActive: Bool
    var size: CGFloat = 48
    var pulseSize: CGFloat = 15
    var music: MusicState?

    var body: some View {
        ZStack {
            Circle()
                .fill(.black)
                .frame(width: size, height: size)
                .overlay(Circle().stroke(.white.opacity(isActive ? 0.08 : 0.045), lineWidth: 1))

            if isActive {
                PulseOrbView(size: pulseSize, music: music)
            } else {
                Image(systemName: systemName)
                .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(ODINDesign.amber)
                    .shadow(color: ODINDesign.amber.opacity(0.55), radius: 9)
            }
        }
    }
}

private struct CapsuleInfo: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .bold))
            Text(text)
                .font(.system(size: 11, weight: .bold))
        }
        .foregroundStyle(ODINDesign.amber)
    }
}

private struct CompactTransportButton: View {
    let systemName: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(ODINDesign.primary)
                .frame(width: 22, height: 22)
                .background(.white.opacity(0.08), in: Circle())
        }
        .buttonStyle(.plain)
    }
}

private struct AlbumArtBadge: View {
    let music: MusicState

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10)
                .fill(
                    LinearGradient(
                        colors: [ODINDesign.amber.opacity(0.95), .pink.opacity(0.62), .black],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            if let artworkURL = music.artworkURL, let url = URL(string: artworkURL) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFill()
                    default:
                        Image(systemName: "music.note")
                            .font(.system(size: 20, weight: .heavy))
                            .foregroundStyle(.black.opacity(0.68))
                    }
                }
            } else {
                Image(systemName: "music.note")
                    .font(.system(size: 20, weight: .heavy))
                    .foregroundStyle(.black.opacity(0.68))
            }
        }
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(alignment: .bottomTrailing) {
                Circle()
                    .fill(Color(red: 0.12, green: 0.78, blue: 0.34))
                    .frame(width: 15, height: 15)
                    .overlay(Image(systemName: "music.note").font(.system(size: 7, weight: .black)).foregroundStyle(.black))
                    .offset(x: 4, y: 4)
            }
    }
}
