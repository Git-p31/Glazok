import SwiftUI

/// Ручная камера: баланс белого, ISO, выдержка, экспокоррекция, положение линзы (фокус).
struct ManualSheet: View {
    @ObservedObject var model: AppModel

    private struct Row {
        let id: String
        let label: String
        let log: Bool
        let fmt: (Double) -> String
    }

    private let rows: [Row] = [
        Row(id: "wb", label: "Баланс белого", log: false) { "\(Int($0.rounded())) K" },
        Row(id: "iso", label: "ISO", log: false) { "ISO \(Int($0.rounded()))" },
        Row(id: "sh", label: "Выдержка", log: true) { v in
            let s = v * 0.0001
            return s >= 0.5 ? String(format: "%.1f с", s) : "1/\(Int((1 / s).rounded()))"
        },
        Row(id: "ev", label: "Эксп-коррекция", log: false) { ($0 > 0 ? "+" : "") + String(format: "%.1f EV", $0) },
        Row(id: "fo", label: "Фокус", log: false) { "линза \(Int(($0 * 100).rounded()))%" }
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(isOn: Binding(get: { model.manualOn }, set: { model.setManual($0) })) {
                Text("Ручной режим").font(.system(size: 14, weight: .bold))
            }
            .tint(Theme.accent2)

            ForEach(rows.filter { model.manualCaps[$0.id] != nil }, id: \.id) { row in
                slider(row)
            }

            Text(model.manualCaps.isEmpty
                 ? "Эта камера не даёт ручные настройки."
                 : "Фокус: нажмите на картинку — камера сфокусируется на этом месте. Слайдер «Фокус» ставит дистанцию вручную (0% — близко, 100% — далеко).")
                .font(.system(size: 11))
                .foregroundColor(Color.white.opacity(0.6))
        }
        .padding(14)
        .frame(maxWidth: 460)
        .background(Color.black.opacity(0.75))
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func slider(_ row: Row) -> some View {
        let caps = model.manualCaps[row.id] ?? [:]
        let lo = (caps["min"] as? NSNumber)?.doubleValue ?? 0
        let hi = max(lo + 0.0001, (caps["max"] as? NSNumber)?.doubleValue ?? 1)
        let current = model.manualVals[row.id] ?? model.camera.currentValues()[row.id] ?? lo
        let value = min(hi, max(lo, current))

        let binding = Binding<Double>(
            get: { row.log ? log(value / lo) / log(hi / lo) : value },
            set: { pos in model.setManualValue(row.id, row.log ? lo * pow(hi / lo, pos) : pos) }
        )
        return HStack(spacing: 10) {
            Text(row.label).font(.system(size: 12)).frame(width: 92, alignment: .leading)
            Slider(value: binding, in: row.log ? 0...1 : lo...hi).tint(Theme.accent2)
            Text(row.fmt(value))
                .font(.system(size: 12, weight: .bold))
                .monospacedDigit()
                .frame(width: 70, alignment: .trailing)
                .onTapGesture(count: 2) { model.resetManualValue(row.id) }
        }
    }
}
