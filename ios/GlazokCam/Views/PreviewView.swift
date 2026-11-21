import AVFoundation
import SwiftUI
import UIKit

/// Превью камеры. Тап — фокус по точке, щипок — зум.
struct PreviewView: UIViewRepresentable {
    @ObservedObject var model: AppModel

    func makeUIView(context: Context) -> PreviewUIView {
        let view = PreviewUIView()
        view.previewLayer.session = model.camera.capturer.captureSession
        view.previewLayer.videoGravity = .resizeAspectFill
        model.previewLayer = view.previewLayer

        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap(_:)))
        view.addGestureRecognizer(tap)
        let pinch = UIPinchGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pinch(_:)))
        view.addGestureRecognizer(pinch)
        return view
    }

    func updateUIView(_ uiView: PreviewUIView, context: Context) {
        if uiView.previewLayer.session !== model.camera.capturer.captureSession {
            uiView.previewLayer.session = model.camera.capturer.captureSession
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    final class Coordinator: NSObject {
        let model: AppModel
        private var pinchStart: Double = 1

        init(model: AppModel) { self.model = model }

        @objc func tap(_ g: UITapGestureRecognizer) {
            guard let view = g.view as? PreviewUIView else { return }
            let point = g.location(in: view)
            let devicePoint = view.previewLayer.captureDevicePointConverted(fromLayerPoint: point)
            model.focus(devicePoint: devicePoint, layerPoint: point)
        }

        @objc func pinch(_ g: UIPinchGestureRecognizer) {
            if g.state == .began { pinchStart = model.zoomValue }
            if g.state == .changed { model.setZoom(pinchStart * Double(g.scale)) }
        }
    }
}

final class PreviewUIView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let connection = previewLayer.connection, connection.isVideoOrientationSupported else { return }
        let orientation = window?.windowScene?.interfaceOrientation ?? .portrait
        switch orientation {
        case .landscapeLeft: connection.videoOrientation = .landscapeLeft
        case .landscapeRight: connection.videoOrientation = .landscapeRight
        case .portraitUpsideDown: connection.videoOrientation = .portraitUpsideDown
        default: connection.videoOrientation = .portrait
        }
    }
}
