import SwiftUI

struct OdinSphereView: View {
    @State private var pulse = false

    var body: some View {
        ZStack {
            Circle()
                .fill(Color(red: 1.0, green: 0.55, blue: 0.08).opacity(0.72))
                .scaleEffect(pulse ? 1.22 : 0.92)
                .opacity(pulse ? 0.18 : 0.42)
                .blur(radius: 2)
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color(red: 1.0, green: 0.66, blue: 0.14),
                            Color(red: 0.48, green: 0.23, blue: 0.03),
                            Color.black,
                        ],
                        center: UnitPoint(x: 0.38, y: 0.34),
                        startRadius: 0,
                        endRadius: 8
                    )
                )
                .shadow(color: Color(red: 1.0, green: 0.52, blue: 0.04).opacity(0.74), radius: 7)
            Circle()
                .fill(Color.white.opacity(0.9))
                .frame(width: 2.2, height: 2.2)
                .offset(x: -2.4, y: -2.3)
        }
        .scaleEffect(pulse ? 1.08 : 1.0)
        .onAppear {
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }
}
