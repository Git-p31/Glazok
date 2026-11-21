import SwiftUI

@main
struct GlazokCamApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ZStack(alignment: .top) {
                switch model.screen {
                case .connect: ConnectView(model: model)
                case .camera: CameraScreen(model: model)
                }
                if let message = model.toast {
                    Text(message)
                        .font(.system(size: 14, weight: .semibold))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(.ultraThinMaterial)
                        .clipShape(Capsule())
                        .padding(.top, 12)
                        .padding(.horizontal, 20)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeOut(duration: 0.2), value: model.toast)
            .preferredColorScheme(.dark)
        }
    }
}
