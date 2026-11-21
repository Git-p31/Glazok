import SwiftUI

struct ConnectView: View {
    @ObservedObject var model: AppModel
    @State private var scanning = false

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                VStack(spacing: 10) {
                    Image(systemName: "eye")
                        .font(.system(size: 34, weight: .semibold))
                        .foregroundColor(Color(red: 0.04, green: 0.05, blue: 0.08))
                        .frame(width: 76, height: 76)
                        .background(LinearGradient(colors: [Theme.accent, Theme.accent2], startPoint: .topLeading, endPoint: .bottomTrailing))
                        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    Text("Glazok").font(.system(size: 34, weight: .heavy))
                    Text("iPhone как беспроводная камера").font(.subheadline).foregroundColor(Theme.muted)
                }
                .padding(.top, 30)
                .padding(.bottom, 8)

                Button { scanning = true } label: {
                    Label("Сканировать QR-код", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity, minHeight: 58)
                }
                .buttonStyle(PrimaryButton())

                HStack { line; Text("или введите код").font(.caption).foregroundColor(Theme.muted); line }

                TextField("ABC123", text: Binding(
                    get: { model.code },
                    set: { model.code = String($0.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(6)); model.codeEditedManually() }
                ))
                .font(.system(size: 28, weight: .heavy, design: .monospaced))
                .multilineTextAlignment(.center)
                .textInputAutocapitalization(.characters)
                .disableAutocorrection(true)
                .padding(.vertical, 14)
                .background(Theme.card)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                VStack(spacing: 6) {
                    TextField("Название телефона", text: $model.deviceName)
                        .multilineTextAlignment(.center)
                        .disableAutocorrection(true)
                        .padding(.vertical, 13)
                        .background(Theme.card)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    Text("Покажется на мониторе. Если пусто — \(model.model).")
                        .font(.caption).foregroundColor(Theme.muted)
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text("Качество видео").font(.headline)
                    Picker("Разрешение", selection: $model.resolution) {
                        Text("720p").tag(720)
                        Text("1080p").tag(1080)
                        Text("4K").tag(2160)
                    }
                    .pickerStyle(.segmented)
                    Picker("Частота", selection: $model.fps) {
                        Text("30 FPS").tag(30)
                        Text("60 FPS").tag(60)
                    }
                    .pickerStyle(.segmented)
                    Toggle("Звук с микрофона", isOn: $model.audioOn)
                }
                .padding(16)
                .background(Theme.card)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))

                Button { model.connect() } label: {
                    Group {
                        if model.busy { ProgressView().tint(.black) } else { Text("Подключить камеру") }
                    }
                    .frame(maxWidth: .infinity, minHeight: 56)
                }
                .buttonStyle(LightButton())
                .disabled(model.busy)
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 30)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.bg.ignoresSafeArea())
        .fullScreenCover(isPresented: $scanning) {
            QRScannerView(onCode: { text in
                scanning = false
                if model.applyScan(text) {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { model.connect() }
                } else {
                    model.show("Это не QR-код Glazok")
                }
            }, onCancel: { scanning = false })
            .ignoresSafeArea()
        }
    }

    private var line: some View { Rectangle().fill(Theme.line).frame(height: 1) }
}

enum Theme {
    static let bg = Color(red: 0.03, green: 0.03, blue: 0.05)
    static let card = Color.white.opacity(0.07)
    static let line = Color.white.opacity(0.12)
    static let muted = Color.white.opacity(0.55)
    static let accent = Color(red: 0.49, green: 0.51, blue: 1.0)
    static let accent2 = Color(red: 0.65, green: 0.55, blue: 1.0)
    static let yellow = Color(red: 0.99, green: 0.90, blue: 0.54)
}

struct PrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .bold))
            .foregroundColor(Color(red: 0.04, green: 0.05, blue: 0.08))
            .background(LinearGradient(colors: [Theme.accent, Theme.accent2], startPoint: .leading, endPoint: .trailing))
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

struct LightButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .bold))
            .foregroundColor(.black)
            .background(Color.white)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}
