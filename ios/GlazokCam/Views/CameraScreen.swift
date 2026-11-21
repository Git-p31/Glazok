import AVFoundation
import SwiftUI

struct CameraScreen: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            PreviewView(model: model).ignoresSafeArea()
            FocusRing(point: model.focusMarker, id: model.focusMarkerID).ignoresSafeArea()

            VStack(spacing: 12) {
                topBar
                Spacer()
                if model.standby { standbyNote }
                Spacer()
                bottomArea
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .statusBarHidden(true)
    }

    // MARK: - Верх

    private var topBar: some View {
        HStack(alignment: .top, spacing: 8) {
            Pill {
                Circle().fill(statusColor).frame(width: 8, height: 8)
                Text(model.statusText)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 6) {
                Pill { Text(model.qualityText) }
                if model.focusSet {
                    Button { model.resetFocus() } label: {
                        Pill { Image(systemName: "scope"); Text("Фокус: точка ✕") }
                    }
                }
            }
        }
    }

    private var statusColor: Color {
        switch model.statusKind {
        case .live: return Color(red: 0.97, green: 0.3, blue: 0.3)
        case .ok: return .green
        case .warning: return .yellow
        case .bad: return .red
        case .idle: return Color.white.opacity(0.6)
        }
    }

    private var standbyNote: some View {
        VStack(spacing: 6) {
            Text("Ожидание эфира").font(.headline)
            Text("Телефон подключён. Видео не передаётся, пока оператор не нажмёт «Запустить эфир» на мониторе. Нажмите на картинку, чтобы выбрать, на чём фокусироваться.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundColor(Color.white.opacity(0.8))
        }
        .padding(18)
        .frame(maxWidth: 340)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .allowsHitTesting(false)
    }

    // MARK: - Низ

    private var bottomArea: some View {
        VStack(spacing: 10) {
            if model.showManual { ManualSheet(model: model) }

            if model.zoomRange.upperBound > model.zoomRange.lowerBound {
                HStack(spacing: 10) {
                    Image(systemName: "plus.magnifyingglass")
                    Slider(value: Binding(get: { model.zoomValue }, set: { model.setZoom($0) }), in: model.zoomRange)
                        .tint(Theme.accent2)
                    Text(String(format: "%.1f×", model.zoomValue)).monospacedDigit().frame(width: 46, alignment: .trailing)
                }
                .font(.system(size: 13, weight: .bold))
                .padding(.horizontal, 16)
                .frame(minHeight: 44)
                .background(.ultraThinMaterial)
                .clipShape(Capsule())
                .frame(maxWidth: 460)
            }

            if model.lenses.count > 1 {
                HStack(spacing: 8) {
                    ForEach(model.lenses, id: \.type) { lens in
                        Button { model.switchLens(lens.type) } label: {
                            Text(lens.title)
                                .font(.system(size: 13, weight: .bold))
                                .frame(width: 54, height: 34)
                                .background(model.currentLens == lens.type ? Theme.yellow.opacity(0.9) : Color.black.opacity(0.45))
                                .foregroundColor(model.currentLens == lens.type ? .black : .white)
                                .clipShape(Capsule())
                        }
                    }
                }
            }

            HStack(spacing: 10) {
                ActionButton(icon: "slider.horizontal.3", title: model.manualOn ? "Ручной ВКЛ" : "Ручной", on: model.manualOn) {
                    model.showManual.toggle()
                }
                ActionButton(icon: "bolt.fill", title: model.torchOn ? "Выключить" : "Вспышка", on: model.torchOn) {
                    model.toggleTorch()
                }
                ActionButton(icon: "arrow.triangle.2.circlepath.camera", title: "Камера", on: false) {
                    model.flipCamera()
                }
                ActionButton(icon: "stop.fill", title: "Стоп", on: false, stop: true) {
                    model.stop()
                }
            }
            .frame(maxWidth: 460)
        }
    }
}

// MARK: - Элементы

struct Pill<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        HStack(spacing: 7) { content }
            .font(.system(size: 12, weight: .bold))
            .foregroundColor(.white)
            .padding(.horizontal, 12)
            .frame(minHeight: 30)
            .background(Color.black.opacity(0.55))
            .overlay(Capsule().stroke(Color.white.opacity(0.13)))
            .clipShape(Capsule())
    }
}

struct ActionButton: View {
    let icon: String
    let title: String
    let on: Bool
    var stop = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 19, weight: .semibold))
                Text(title).font(.system(size: 11, weight: .bold)).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, minHeight: 62)
            .foregroundColor(stop ? Color(red: 1, green: 0.8, blue: 0.8) : (on ? Theme.yellow : .white))
            .background(stop ? Color.red.opacity(0.22) : (on ? Color.yellow.opacity(0.22) : Color.black.opacity(0.5)))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Color.white.opacity(0.13)))
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }
}

/// Жёлтая рамка в месте фокуса: появляется и через 1.4 с гаснет.
struct FocusRing: View {
    let point: CGPoint?
    let id: Int
    @State private var visible = false
    @State private var scale: CGFloat = 1.35
    @State private var shownID = 0

    var body: some View {
        GeometryReader { _ in
            if let p = point {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Theme.yellow, lineWidth: 2)
                    .frame(width: 76, height: 76)
                    .scaleEffect(scale)
                    .opacity(visible ? 1 : 0)
                    .position(p)
            }
        }
        .allowsHitTesting(false)
        .onChange(of: id) { newID in
            shownID = newID
            visible = true
            scale = 1.35
            withAnimation(.easeOut(duration: 0.25)) { scale = 1 }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                if shownID == newID { withAnimation(.easeOut(duration: 0.8)) { visible = false } }   // новая рамка не гаснет раньше времени
            }
        }
    }
}
